class OrganizerError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message

    def as_dict(self) -> dict:
        return {"code": self.code, "message": self.message}


class QueueFullError(OrganizerError):
    def __init__(self):
        super().__init__("SERVER_BUSY", "The clustering queue is full. Try again later.")


class QueueTimeoutError(OrganizerError):
    def __init__(self):
        super().__init__("QUEUE_TIMEOUT", "Timed out while waiting for the clustering job.")
