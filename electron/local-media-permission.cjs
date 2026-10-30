// Called only after the main process verifies the requesting local app origin.
function localMediaPermission(permission, details, check = false) {
  const allowed = (type) => type === 'audio' || type === 'video';
  return (
    permission === 'media' &&
    (check
      ? allowed(details?.mediaType)
      : Array.isArray(details?.mediaTypes) &&
        details.mediaTypes.length > 0 &&
        details.mediaTypes.every(allowed))
  );
}
module.exports = { localMediaPermission };
