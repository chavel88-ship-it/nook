import os
from uuid import uuid4

def generate_image(prompt):
    """
    Placeholder image generator.

    In the next step this will call the real image API.
    """

    filename = f"{uuid4()}.png"

    return {
        "success": True,
        "prompt": prompt,
        "image_url": f"/images/{filename}"
    }