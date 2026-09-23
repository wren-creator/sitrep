"""Base class every data source plugin implements.

Drop a new file in backend/plugins/ with a SitrepPlugin subclass named `Plugin`
and the runner picks it up. No core changes needed.
"""
from abc import ABC, abstractmethod
from typing import Any


class SitrepPlugin(ABC):
    name: str = ""
    layer: str = ""  # disaster | conflict | aviation | health | election | advisory | currency | ...
    cache_ttl_seconds: int = 900

    @abstractmethod
    async def fetch(self) -> Any:
        """Pull the raw payload from the external source."""

    @abstractmethod
    def normalize(self, raw: Any) -> list[dict]:
        """Return GeoJSON Features. Properties must include:
        id, layer, severity (low|medium|high|critical), title, summary,
        timestamp (ISO-8601 UTC), source_url.
        Country-level sources set properties.iso2 and may use geometry None.
        """
