"""Optional, completed downloads prepared by the desktop model library.

The caller still verifies the actual pinned model files before inference.
No download, scanning, or model initialization is performed here.
"""
from pathlib import Path
import json
import os


def managed_directory(model_id, revision, relative=''):
    configured = os.environ.get('SURFACETAB_MANAGED_MODELS')
    if not configured:
        return None
    folder = Path(configured) / model_id / revision
    try:
        completed = json.loads((folder / '.complete.json').read_text('utf-8'))
        if completed.get('id') == model_id and completed.get('revision') == revision:
            return folder / relative
    except (OSError, ValueError):
        pass
    return None
