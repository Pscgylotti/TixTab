// Only microphone capture is needed for score following. Camera requests stay denied.
function audioPermission(permission, details, check = false) {
  return (
    permission === 'media' &&
    (check
      ? details?.mediaType === 'audio'
      : Array.isArray(details?.mediaTypes) &&
        details.mediaTypes.length > 0 &&
        details.mediaTypes.every((type) => type === 'audio'))
  );
}
module.exports = { audioPermission };
