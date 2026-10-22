"""Shared daemon API errors and OS-error translation."""
# ------------------------------------------------------------------ errors
class ApiError(Exception):
    def __init__(self, code, message, status=400, details=None):
        super().__init__(message)
        self.code, self.message, self.status, self.details = code, message, status, details


def os_error(e, what=""):
    import errno as E
    m = {E.ENOENT: ("NOT_FOUND", 404), E.EACCES: ("PERMISSION_DENIED", 403), E.EPERM: ("PERMISSION_DENIED", 403),
         E.EEXIST: ("ALREADY_EXISTS", 409), E.ENOTEMPTY: ("NOT_EMPTY", 409), E.ENOSPC: ("STORAGE_FULL", 507),
         E.EISDIR: ("IS_DIRECTORY", 400), E.ENOTDIR: ("NOT_DIRECTORY", 400), E.ELOOP: ("SYMLINK_LOOP", 400),
         E.ETXTBSY: ("FILE_LOCKED", 423), E.EBUSY: ("FILE_LOCKED", 423), E.EROFS: ("READ_ONLY", 403),
         E.ENAMETOOLONG: ("INVALID_PATH", 400)}
    code, st = m.get(e.errno, ("IO_ERROR", 500))
    return ApiError(code, (what + ": " if what else "") + (e.strerror or str(e)), st, "errno=%s" % e.errno)


