/* =========================================================================
   A four-line event bus, for one job only.

   The orb is the single source of truth for "what is happening right now",
   and three things follow it: the telemetry rails, the barge-in listener, and
   the ambient hint text. They are observers, not dependencies — the orb must
   not have to know they exist, and each of them already imports the orb to
   read its state. Publishing instead of calling keeps that arrow pointing one
   way. Subscribers are registered in app.js, in the order they used to be
   called in, so ordering stays visible in one place rather than implied by
   import order.
   ========================================================================= */

var handlers = Object.create(null);

export function on(event, fn) {
  (handlers[event] || (handlers[event] = [])).push(fn);
}

export function emit(event, arg) {
  var list = handlers[event];
  if (!list) return;
  for (var i = 0; i < list.length; i++) list[i](arg);
}
