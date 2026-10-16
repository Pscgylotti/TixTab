/** A presentation owns only the fullscreen transition it requested. */
export async function presentationFullscreen() {
  const desktop = window.surfaceDesktop;
  try {
    if (desktop?.fullscreenState) {
      const previous = await desktop.fullscreenState();
      if (!previous) await desktop.fullscreenState(true);
      return async () => {
        if (!previous && (await desktop.fullscreenState!())) await desktop.fullscreenState!(false);
      };
    }
    const previous = document.fullscreenElement;
    if (!previous) await document.documentElement.requestFullscreen();
    return async () => {
      if (!previous && document.fullscreenElement) await document.exitFullscreen();
    };
  } catch {
    // The borderless in-window presentation remains usable if the host denies fullscreen.
    return async () => {};
  }
}
