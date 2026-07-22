"""
Thin wrapper around the IBM watsonx.ai text generation API.

Swap in real credentials via environment variables:
  WATSONX_API_KEY       — IBM Cloud API key
  WATSONX_PROJECT_ID    — watsonx project ID
  WATSONX_URL           — regional endpoint (default: us-south)
  WATSONX_MODEL_ID      — model to use
  WATSONX_USE_MOCK      — set to "false" to hit the real API

IAM token caching
-----------------
The IAM bearer token is cached in memory and reused until 60 seconds before
its expiry, eliminating a redundant round-trip on every generate() call.
The cache is protected by a threading.Lock so it is safe under Flask's
multi-threaded dev server and under gunicorn with threaded workers.
"""

import os
import time
import threading
import requests

# ── Config ────────────────────────────────────────────────────────────────
WATSONX_API_KEY    = os.environ.get("WATSONX_API_KEY",    "placeholder-key")
WATSONX_PROJECT_ID = os.environ.get("WATSONX_PROJECT_ID", "placeholder-project-id")
WATSONX_URL        = os.environ.get("WATSONX_URL",        "https://us-south.ml.cloud.ibm.com")
MODEL_ID           = os.environ.get("WATSONX_MODEL_ID",   "ibm/granite-13b-chat-v2")

USE_MOCK = os.environ.get("WATSONX_USE_MOCK", "true").lower() == "true"

_CREDS_MISSING = (
    WATSONX_API_KEY    == "placeholder-key"
    or WATSONX_PROJECT_ID == "placeholder-project-id"
)

# Seconds before the token's expiry at which we proactively refresh it.
_TOKEN_REFRESH_BUFFER = 60


# ── WatsonxError ──────────────────────────────────────────────────────────

class WatsonxError(RuntimeError):
    """Raised for any failure communicating with the watsonx API.

    Attributes:
        status_code: HTTP status returned by the server, if available.
        retryable:   True when the failure is likely transient.
        retry_after: Seconds to wait before retrying (Retry-After header), or None.
    """

    def __init__(
        self,
        message: str,
        status_code: int | None = None,
        retryable: bool = False,
        retry_after: float | None = None,
    ):
        super().__init__(message)
        self.status_code = status_code
        self.retryable   = retryable
        self.retry_after = retry_after


# ── IAM token cache ───────────────────────────────────────────────────────

_token_lock   = threading.Lock()
_cached_token: str | None = None
_token_expiry: float = 0.0  # Unix timestamp


def _get_iam_token() -> str:
    """
    Return a valid IAM bearer token.

    Uses the in-memory cache: if the cached token is still valid (expiry minus
    the refresh buffer is in the future) it is returned immediately with no
    network call.  Otherwise a fresh token is fetched and the cache is updated.
    """
    global _cached_token, _token_expiry

    with _token_lock:
        if _cached_token and time.time() < (_token_expiry - _TOKEN_REFRESH_BUFFER):
            return _cached_token

        # Fetch a fresh token
        try:
            resp = requests.post(
                "https://iam.cloud.ibm.com/identity/token",
                data={
                    "grant_type": "urn:ibm:params:oauth:grant-type:apikey",
                    "apikey": WATSONX_API_KEY,
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                timeout=15,
            )
            resp.raise_for_status()
            body = resp.json()
        except requests.exceptions.Timeout:
            raise WatsonxError("IAM token request timed out.", retryable=True)
        except requests.exceptions.ConnectionError as exc:
            raise WatsonxError(f"Cannot reach IAM endpoint: {exc}", retryable=True)
        except requests.exceptions.HTTPError as exc:
            status    = exc.response.status_code
            retryable = status >= 500
            raise WatsonxError(
                f"IAM authentication failed (HTTP {status}).",
                status_code=status,
                retryable=retryable,
            )
        except (KeyError, ValueError) as exc:
            raise WatsonxError(f"Unexpected IAM response format: {exc}")

        token = body.get("access_token")
        if not token:
            raise WatsonxError(
                "IAM response did not contain an access_token.",
                retryable=False,
            )

        # expires_in is in seconds; default to 1 hour if absent
        expires_in    = float(body.get("expires_in", 3600))
        _cached_token = token
        _token_expiry = time.time() + expires_in
        return token


# ── Helpers ───────────────────────────────────────────────────────────────

def _parse_retry_after(response: requests.Response) -> float | None:
    """Return the Retry-After value in seconds, or None if absent/unparseable."""
    header = response.headers.get("Retry-After")
    if not header:
        return None
    try:
        return float(header)
    except ValueError:
        return 60.0  # HTTP-date fallback


# ── Core generate ─────────────────────────────────────────────────────────

def generate(prompt: str, max_new_tokens: int = 400, temperature: float = 0.7) -> str:
    """
    Send a prompt to watsonx and return the generated text.
    Falls back to mock responses when USE_MOCK is True or credentials are missing.

    Raises:
        WatsonxError on any network, HTTP, or response-shape failure.
    """
    if USE_MOCK or _CREDS_MISSING:
        return _mock_generate(prompt)

    token = _get_iam_token()  # raises WatsonxError if auth fails
    payload = {
        "model_id":   MODEL_ID,
        "input":      prompt,
        "parameters": {
            "max_new_tokens": max_new_tokens,
            "temperature":    temperature,
        },
        "project_id": WATSONX_PROJECT_ID,
    }
    try:
        resp = requests.post(
            f"{WATSONX_URL}/ml/v1/text/generation?version=2023-05-29",
            json=payload,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type":  "application/json",
            },
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()

        results = data.get("results")
        if not isinstance(results, list) or not results:
            raise WatsonxError(
                "watsonx response missing 'results' list.",
                retryable=False,
            )
        generated = results[0].get("generated_text")
        if generated is None:
            raise WatsonxError(
                "watsonx result missing 'generated_text' field.",
                retryable=False,
            )
        return generated.strip()

    except requests.exceptions.Timeout:
        raise WatsonxError("Text generation request timed out.", retryable=True)
    except requests.exceptions.ConnectionError as exc:
        raise WatsonxError(f"Cannot reach watsonx endpoint: {exc}", retryable=True)
    except requests.exceptions.HTTPError as exc:
        status      = exc.response.status_code
        retry_after = _parse_retry_after(exc.response) if status == 429 else None
        retryable   = status == 429 or status >= 500
        msg = {
            401: "watsonx authentication failed — check WATSONX_API_KEY.",
            403: "watsonx access denied — check WATSONX_PROJECT_ID permissions.",
            429: "Rate limit exceeded — please wait a moment and try again.",
        }.get(status, f"watsonx returned HTTP {status}.")
        raise WatsonxError(msg, status_code=status, retryable=retryable, retry_after=retry_after)
    except (KeyError, IndexError, ValueError) as exc:
        raise WatsonxError(f"Unexpected response shape from watsonx: {exc}")


def generate_with_retry(
    prompt: str,
    max_new_tokens: int = 400,
    temperature: float = 0.7,
    retries: int = 2,
    backoff: float = 2.0,
) -> str:
    """
    Calls generate() and retries up to `retries` times on transient failures.

    Respects a Retry-After header when present; falls back to exponential
    back-off (backoff, backoff*2, … seconds).

    Raises:
        WatsonxError if all attempts fail or the error is not retryable.
    """
    for attempt in range(retries + 1):
        try:
            return generate(prompt, max_new_tokens=max_new_tokens, temperature=temperature)
        except WatsonxError as exc:
            if not exc.retryable or attempt == retries:
                raise
            wait = exc.retry_after if exc.retry_after is not None else backoff * (2 ** attempt)
            time.sleep(wait)


# ── Mock responses ────────────────────────────────────────────────────────

def _mock_generate(prompt: str) -> str:
    """
    Canned responses for local development and testing.
    Attempts to extract the business name from the prompt so demo runs
    look personalised rather than generic.
    """
    import re
    lower = prompt.lower()

    # Extract business name from structured prompts
    biz_match = re.search(
        r"(?:Business:|for a)\s*([^\n,]+?)(?:\s+targeting|$|\n)", prompt
    )
    business = biz_match.group(1).strip() if biz_match else None
    if not business:
        alt = re.search(
            r"\b([A-Z][A-Za-z']*(?:\s+[A-Z][A-Za-z']*)*\s+"
            r"(?:Bakes|Bakery|Studio|Co\.?|Shop))\b",
            prompt,
        )
        business = alt.group(1).strip() if alt else "your business"

    if "distinct content directions" in lower or "generate 3 to 5" in lower:
        return (
            f"Playful & punchy — a fun, relatable moment tied to {business}.\n"
            f"Warm & story-driven — open with a short story about {business}.\n"
            "Bold & direct — lead with the offer or benefit, no fluff.\n"
        )

    if "suggest 5 relevant hashtags" in lower:
        return "#ShopLocal #SmallBusiness #SupportLocal #HomeBaked #FreshDaily"

    if "describe a visual concept" in lower:
        return (
            f"A warm, close-up shot of {business}'s products on a wooden surface, "
            "natural light, nothing fussy — just the product and a warm mug nearby."
        )

    if "please revise it based on this feedback" in lower:
        return (
            f"Hi, it's us at {business}! Every order is made with the same care "
            "we'd want for our own family. Message us to grab yours before it's gone."
        )

    if "write a" in lower and "post for a" in lower:
        return (
            f"There's nothing quite like the real thing. {business} started as a way "
            "to share that with the neighbourhood — now we'd love to share it with you."
        )

    return "[mock watsonx response] " + prompt[:120]
