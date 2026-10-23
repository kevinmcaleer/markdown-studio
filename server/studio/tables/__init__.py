"""Tables: an Access-style database app with a spreadsheet-like grid.

See :mod:`studio.tables.api` for the routes, :mod:`.types` for field types and
:mod:`.query` for filters, sorting and queries.
"""

import mimetypes

MIME_TYPE = "application/vnd.markdown-studio.tables+json"
EXTENSION = ".tables"

# So a .tables file keeps its type when it's uploaded or renamed.
mimetypes.add_type(MIME_TYPE, EXTENSION)
