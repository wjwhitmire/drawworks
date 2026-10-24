"""CPM scheduling library: calendars, critical path, progress, resources, XER and MSPDI files."""

from .brand import PRODUCT_NAME
from .errors import SchedError

__all__ = ["PRODUCT_NAME", "SchedError"]
__version__ = "0.1.0"
