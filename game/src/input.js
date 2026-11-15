// Keyboard + mouse for EMBERLINE: WASD move, Space jump, Ctrl/C crouch,
// R reload, 1/2/3 weapon, G grenade, E hold plant/defuse, B buy menu.
// `keys` holds everything currently down; `pressed` records each fresh
// keydown once (no auto-repeat) so main.js can consume one-shot actions,
// then clears it with clearPressed() at the end of each tick.
export function createInput(canvas, onLockChange) {
  const keys = new Set();
  const pressed = new Set();
  const state = { keys, locked: false, firing: false, lookX: 0, lookY: 0, pressed };

  function onKeyDown(event) {
    if (event.repeat) return;
    keys.add(event.code);
    pressed.add(event.code);
    if (event.code === 'Space') event.preventDefault();
  }

  function onKeyUp(event) {
    keys.delete(event.code);
  }

  function onBlur() {
    keys.clear();
    pressed.clear();
    state.firing = false;
  }

  function onMouseMove(event) {
    if (!state.locked) return;
    state.lookX += event.movementX;
    state.lookY += event.movementY;
  }

  function onMouseDown(event) {
    if (state.locked && event.button === 0) state.firing = true;
  }

  function onMouseUp(event) {
    if (event.button === 0) state.firing = false;
  }

  function onLock() {
    state.locked = document.pointerLockElement === canvas;
    if (!state.locked) {
      keys.clear();
      pressed.clear();
      state.firing = false;
    }
    if (onLockChange) onLockChange(state.locked);
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  document.addEventListener('pointerlockchange', onLock);

  return {
    state,
    requestLock() {
      canvas.requestPointerLock();
    },
    takeLook() {
      const x = state.lookX;
      const y = state.lookY;
      state.lookX = 0;
      state.lookY = 0;
      return { x, y };
    },
    clearPressed() {
      pressed.clear();
    },
  };
}
