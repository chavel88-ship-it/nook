"""
Core conversation workflow for Nook.

Stages:
  INTAKE          -> collecting business type, audience, goal, tone, platform
  IDEATION_CHOICE -> user picks one of 3-5 generated content directions
  REFINEMENT      -> user iterates on a draft (capped at MAX_REFINEMENTS)
  DONE            -> final output package delivered

Error contract
--------------
Every handler returns a plain dict.  On success the dict always has:
  - reply   (str)   human-readable text to display
  - stage   (str)   current session stage

On error the dict additionally has:
  - error      (True)  sentinel flag for the frontend
  - retryable  (bool)  whether the user can simply resend the same message
"""

import re
from watsonx_client import generate_with_retry as generate, WatsonxError

INTAKE_QUESTIONS = [
    ("business", "What's your business or what do you do?"),
    ("audience", "Who's the audience for this content?"),
    ("goal",     "What's the goal — awareness, sales, engagement, something else?"),
    ("tone",     "What tone do you want — playful, professional, warm, bold...?"),
    ("platform", "Which platform is this for (Instagram, LinkedIn, email, etc.)?"),
]

# Maximum number of refinement rounds before nudging the user to finish.
MAX_REFINEMENTS = 10


class Session:
    """Holds one user's conversation state."""

    def __init__(self, session_id: str):
        self.id              = session_id
        self.stage           = "INTAKE"
        self.intake_index    = 0
        self.answers         = {}
        self.directions      = []
        self.chosen_direction = None
        self.current_draft   = None
        self.refine_count    = 0   # incremented on every successful refinement

    def to_dict(self):
        return {
            "stage":            self.stage,
            "answers":          self.answers,
            "directions":       self.directions,
            "chosen_direction": self.chosen_direction,
            "current_draft":    self.current_draft,
            "refine_count":     self.refine_count,
        }


def handle_message(session_id: str, message: str) -> dict:
    """
    Main entry point — loads the session from the store, routes to the
    correct stage handler, persists any state changes, then returns the reply.
    """
    # Import here to avoid a circular import at module load time
    from session_store import load_session, save_session

    session = load_session(session_id)

    if session.stage == "INTAKE":
        result = _handle_intake(session, message)
    elif session.stage == "IDEATION_CHOICE":
        result = _handle_direction_choice(session, message)
    elif session.stage == "REFINEMENT":
        result = _handle_refinement(session, message)
    else:
        return {
            "reply": "This session is complete. Start a new one to create another brief.",
            "stage": session.stage,
        }

    # Persist after every handler, even on error responses (stage may be unchanged
    # but intake_index or answers could have been updated).
    save_session(session)
    return result


# ---------------------------------------------------------------------------
# Stage handlers
# ---------------------------------------------------------------------------

def _handle_intake(session: Session, message: str) -> dict:
    # first call (session start) just kicks off the flow; subsequent calls
    # store the previous answer before advancing.
    if session.intake_index > 0:
        key = INTAKE_QUESTIONS[session.intake_index - 1][0]
        session.answers[key] = message.strip()

    if session.intake_index < len(INTAKE_QUESTIONS):
        _, question = INTAKE_QUESTIONS[session.intake_index]
        session.intake_index += 1
        return {
            "reply": question,
            "stage": session.stage,
            "intake_progress": {
                "current": session.intake_index,
                "total":   len(INTAKE_QUESTIONS),
            },
        }

    # All intake answers collected — generate ideation directions
    return _run_ideation(session)


def _run_ideation(session: Session) -> dict:
    prompt = _build_ideation_prompt(session.answers)
    try:
        raw = generate(prompt)
    except WatsonxError as exc:
        hint = "Please try again in a moment." if exc.retryable else "Please contact support."
        # Stage stays INTAKE so the user can resend their last answer
        return {
            "reply": f"Sorry, I couldn't generate ideas right now. {hint}",
            "stage": session.stage,
            "error": True,
            "retryable": exc.retryable,
            "error_detail": str(exc),
        }

    directions = []
    for line in raw.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        line = re.sub(r"^[\d]+[\.\)]\s*|^[-•]\s*", "", line)
        if line:
            directions.append(line)

    if not directions:
        return {
            "reply": "Hmm, I got an empty response. Please try again.",
            "stage": session.stage,
            "error": True,
            "retryable": True,
        }

    session.directions = directions
    session.stage      = "IDEATION_CHOICE"

    reply = "Here are a few directions based on what you told me:\n\n"
    for i, d in enumerate(directions, start=1):
        reply += f"{i}. {d}\n"
    reply += "\nWhich one do you want to go with? (reply with the number)"
    return {"reply": reply, "stage": session.stage, "directions": directions}


def _handle_direction_choice(session: Session, message: str) -> dict:
    try:
        idx    = int(message.strip()) - 1
        chosen = session.directions[idx]
    except (ValueError, IndexError):
        return {
            "reply": "Please reply with the number of the direction you'd like.",
            "stage": session.stage,
        }

    prompt = _build_draft_prompt(session.answers, chosen)
    try:
        draft = generate(prompt)
    except WatsonxError as exc:
        hint = "Please try again in a moment." if exc.retryable else "Please contact support."
        # Stage stays IDEATION_CHOICE — user can resend the number
        return {
            "reply": f"Sorry, I couldn't generate a draft right now. {hint}",
            "stage": session.stage,
            "error": True,
            "retryable": exc.retryable,
            "error_detail": str(exc),
        }

    # Only advance state after a successful API call
    session.chosen_direction = chosen
    session.stage            = "REFINEMENT"
    session.current_draft    = draft

    reply = (
        f"Here's a first draft:\n\n{draft}\n\n"
        "Want any changes? (tone, length, add a CTA, etc.) "
        "Or reply 'done' if you're happy with this."
    )
    return {"reply": reply, "stage": session.stage, "draft": draft}


def _handle_refinement(session: Session, message: str) -> dict:
    if message.strip().lower() == "done":
        try:
            output = _build_output_package(session)
        except WatsonxError as exc:
            hint = "Please try again in a moment." if exc.retryable else "Please contact support."
            return {
                "reply": (
                    f"Sorry, I couldn't build the final package. {hint} "
                    "Reply 'done' to try again."
                ),
                "stage": session.stage,
                "error": True,
                "retryable": exc.retryable,
                "error_detail": str(exc),
            }
        session.stage = "DONE"
        return {
            "reply": "Here's your final package:\n\n" + output,
            "stage": session.stage,
            "output": output,
        }

    # ── Refinement loop limit ──────────────────────────────────────────────
    if session.refine_count >= MAX_REFINEMENTS:
        return {
            "reply": (
                f"You've refined this {MAX_REFINEMENTS} times — you're clearly a perfectionist! "
                "Reply 'done' to get your final package, or start a new brief to go again."
            ),
            "stage": session.stage,
        }

    prompt = _build_refine_prompt(session.answers, session.current_draft, message)
    try:
        refined = generate(prompt)
    except WatsonxError as exc:
        hint = "Please try again in a moment." if exc.retryable else "Please contact support."
        return {
            "reply": f"Sorry, I couldn't apply that change. {hint}",
            "stage": session.stage,
            "error": True,
            "retryable": exc.retryable,
            "error_detail": str(exc),
        }

    session.current_draft = refined
    session.refine_count += 1

    remaining = MAX_REFINEMENTS - session.refine_count
    footer = (
        f"\n\n({remaining} refinement{'s' if remaining != 1 else ''} remaining — "
        "reply 'done' when you're happy.)"
        if remaining <= 3
        else "\n\nAnything else? Or reply 'done' to finish."
    )
    return {"reply": f"Updated:\n\n{refined}{footer}", "stage": session.stage, "draft": refined}


# ---------------------------------------------------------------------------
# Prompt builders
# ---------------------------------------------------------------------------

def _build_ideation_prompt(answers: dict) -> str:
    return (
        "You are a creative partner helping a small business owner. "
        "Generate 3 to 5 distinct content directions (not full drafts, just short "
        "descriptions of different angles) based on this brief:\n"
        f"Business: {answers.get('business')}\n"
        f"Audience: {answers.get('audience')}\n"
        f"Goal: {answers.get('goal')}\n"
        f"Tone: {answers.get('tone')}\n"
        f"Platform: {answers.get('platform')}\n"
        "List each direction on its own line."
    )


def _build_draft_prompt(answers: dict, direction: str) -> str:
    return (
        f"Write a {answers.get('platform')} post for a {answers.get('business')} "
        f"targeting {answers.get('audience')}, with the goal of {answers.get('goal')}. "
        f"Tone: {answers.get('tone')}. "
        f"Direction to follow: {direction}. "
        "Keep it platform-appropriate length."
    )


def _build_refine_prompt(answers: dict, current_draft: str, feedback: str) -> str:
    return (
        f"Here is a current draft:\n{current_draft}\n\n"
        f"Please revise it based on this feedback: {feedback}\n"
        f"Keep the tone: {answers.get('tone')}, and keep it appropriate for "
        f"{answers.get('platform')}."
    )


def _build_output_package(session: Session) -> str:
    """
    Generates hashtags and a visual concept to accompany the final draft.
    Each generate() call is individually wrapped so a failure in the second
    does not discard the first result.
    """
    answers = session.answers
    draft   = session.current_draft

    hashtag_prompt = (
        f"Suggest 5 relevant hashtags for a {answers.get('platform')} post about "
        f"{answers.get('business')} aimed at {answers.get('audience')}."
    )
    try:
        hashtags = generate(hashtag_prompt)
    except WatsonxError:
        raise

    visual_prompt = (
        f"Briefly describe a visual concept (1-2 sentences) that would pair well "
        f"with this post: {draft}"
    )
    try:
        visual = generate(visual_prompt)
    except WatsonxError:
        raise

    return (
        f"POST COPY:\n{draft}\n\n"
        f"HASHTAGS:\n{hashtags}\n\n"
        f"VISUAL CONCEPT:\n{visual}"
    )
