const os = require('node:os');
/** Local inference yields the CPU to pen input and page rendering. A result that
 * arrives slightly later costs less than a hot device or a dropped ink frame. */
function lowerPriority(child) {
  try {
    if (child && child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {}
}
module.exports = { lowerPriority };
