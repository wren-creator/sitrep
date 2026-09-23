class FactsError(Exception):
    """A provider could not produce facts for a country. The message is shown to the user, so keep it plain."""
