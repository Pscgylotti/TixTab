/** Auxiliary windows must never keep a closed editor running or survive its exit. */
function bindWindowLifecycle(mainWindow, app) {
  const children = new Set();
  let closed = false;
  const destroyChildren = () => {
    for (const child of children) {
      if (!child.isDestroyed()) child.destroy();
    }
    children.clear();
  };
  const created = (child) => {
    if (closed) {
      if (!child.isDestroyed()) child.destroy();
      return;
    }
    children.add(child);
    child.once('closed', () => children.delete(child));
  };
  mainWindow.webContents.on('did-create-window', created);
  app.once('before-quit', destroyChildren);
  mainWindow.once('closed', () => {
    closed = true;
    destroyChildren();
    app.removeListener('before-quit', destroyChildren);
    // window-all-closed alone can be blocked by an empty/closing popup.
    app.quit();
  });
}
module.exports = { bindWindowLifecycle };
