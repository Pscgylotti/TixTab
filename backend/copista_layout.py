"""Attach detector coordinates to MusicXML notes at emission, before voice/tie reordering.

Adapter for copisteria 1.3.4 (pinned c685f280). Upstream is unmodified.
"""
from contextlib import contextmanager
import math


def normalized_box(box, width, height):
    if width <= 0 or height <= 0 or not all(math.isfinite(v) for v in box):
        raise ValueError('score-format')
    x0, y0, x1, y1 = box
    x = max(0., min(.999999, x0 / width))
    y = max(0., min(.999999, y0 / height))
    return dict(x=x, y=y, width=max(.000001, min(1., x1 / width) - x),
                height=max(.000001, min(1., y1 / height) - y))


@contextmanager
def mapped_writer(reading, writer):
    layout = reading.layout
    if len(layout.systems) > 256:
        raise ValueError('score-limit')
    systems = []
    for system in layout.systems:
        staves = [layout.staves[i] for i in system.staves]
        if not staves:
            raise ValueError('score-format')
        systems.append(normalized_box((min(s.x0 for s in staves),
                                       min(s.y0 - 2 * s.sp for s in staves),
                                       max(s.x1 for s in staves),
                                       max(s.y1 + 2 * s.sp for s in staves)),
                                      layout.width, layout.height))
    locations = {}
    original = writer._note

    def emit(measure, event, *args, **kwargs):
        result = original(measure, event, *args, **kwargs)
        if event.kind == 'note' and 0 <= event.si < len(layout.syms):
            symbol = layout.syms[event.si]
            if 0 <= symbol.staff < len(layout.staves):
                system = layout.staves[symbol.staff].system
                if not 0 <= system < len(systems):
                    raise ValueError('score-format')
                if len(locations) >= 20000:
                    raise ValueError('score-limit')
                identifier = 'copista-note-' + str(len(locations))
                # The pinned writer appends one <note>; it does not return it.
                node = measure[-1]
                if node.tag != 'note':
                    raise ValueError('score-format')
                node.set('id', identifier)
                locations[identifier] = dict(system=system, detected=True,
                    region=normalized_box(symbol.box, layout.width, layout.height))
        return result

    writer._note = emit
    try:
        yield dict(systems=systems, noteLocations=locations)
    finally:
        writer._note = original
