"""
Core conversation workflow for Nook.

Stages:
  INTAKE          -> collecting business_name, industry, target_audience,
                     campaign_goal, tone, platform
  DONE            -> full campaign package delivered

Error contract
--------------
Every handler returns a plain dict.  On success the dict always has:
  - reply   (str)   human-readable text to display
  - stage   (str)   current session stage

On error the dict additionally has:
  - error      (True)  sentinel flag for the frontend
  - retryable  (bool)  whether the user can simply resend the same message
"""

from watsonx_client import generate_campaign, WatsonxError

INTAKE_QUESTIONS = [
    ("business_name",    "What's your business name?"),
    ("industry",         "What industry are you in?"),
    ("target_audience",  "Who is your target audience?"),
    ("campaign_goal",    "What's your main campaign goal?"),
    ("tone",             "How would you describe your brand tone? (e.g. friendly, bold, professional)"),
    ("platform",         "Which platform is your primary channel? (e.g. Instagram, LinkedIn, Facebook)"),
]

MAX_REFINEMENTS = 10


class Session:
    """Holds one user's conversation state."""

    def __init__(self, session_id: str):
        self.id               = session_id
        self.stage            = "INTAKE"
        self.intake_index     = 0
        self.answers          = {}
        self.directions       = []
        self.chosen_direction = None
        self.current_draft    = None
        self.refine_count     = 0

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
    from session_store import load_session, save_session

    session = load_session(session_id)

    # ── First call: kick off with the first intake question ──────────────
    if session.stage == "INTAKE" and session.intake_index == 0:
        question = INTAKE_QUESTIONS[0][1]
        session.intake_index = 1
        save_session(session)
        return {
            "stage": session.stage,
            "reply": question,
            "intake_progress": {"current": 1, "total": len(INTAKE_QUESTIONS)},
        }

    # ── Collect intake answers ────────────────────────────────────────────
    if session.stage == "INTAKE":
        key = INTAKE_QUESTIONS[session.intake_index - 1][0]
        session.answers[key] = message.strip()

        if session.intake_index < len(INTAKE_QUESTIONS):
            question = INTAKE_QUESTIONS[session.intake_index][1]
            session.intake_index += 1
            save_session(session)
            return {
                "stage": session.stage,
                "reply": question,
                "intake_progress": {
                    "current": session.intake_index,
                    "total":   len(INTAKE_QUESTIONS),
                },
            }

        # All answers collected — generate campaign
        try:
            campaign = generate_campaign(
                business_name=session.answers["business_name"],
                industry=session.answers["industry"],
                target_audience=session.answers["target_audience"],
                campaign_goal=session.answers["campaign_goal"],
                tone=session.answers["tone"],
                platform=session.answers["platform"],
            )
        except WatsonxError as exc:
            return {
                "error":    True,
                "retryable": exc.retryable,
                "reply":    str(exc),
                "stage":    session.stage,
            }
        except Exception as exc:
            return {
                "error":    True,
                "retryable": False,
                "reply":    f"Campaign generation failed: {exc}",
                "stage":    session.stage,
            }

        session.stage = "DONE"
        save_session(session)

        return {
            "stage":    "DONE",
            "campaign": campaign,
            "reply":    "Your campaign is ready! Here's your full marketing package.",
        }

    # ── Already done ──────────────────────────────────────────────────────
    return {
        "stage": session.stage,
        "reply": "Your campaign is already complete. Click '+ New campaign' to start a new one.",
    }
