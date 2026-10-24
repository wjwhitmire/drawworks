"""One error type with a stable code and a plain message, mirrored by the browser core."""


class SchedError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message
