"""Carry homr symbol locations through XML generation without retaining image buffers."""
import math


def normalized_rect(x, y, width, height, image_width, image_height, crop):
    x = min(.999999, max(0., crop['x'] + x / image_width * crop['width']))
    y = min(.999999, max(0., crop['y'] + y / image_height * crop['height']))
    return dict(x=x, y=y,
                width=min(1 - x, max(.000001, width / image_width * crop['width'])),
                height=min(1 - y, max(.000001, height / image_height * crop['height'])))


def locate_symbol(point, transform, candidates, unit):
    """Attention pixels -> source pixels; snap only to nearby detected noteheads.

    homr's staff dewarp changes Y only. The two crops and canvas resize still
    change X, and must be undone before interpreting a cursor position.
    candidates contain (canvas center, original center), never image arrays.
    """
    if point is None or len(point) < 2 or not all(math.isfinite(float(v)) for v in point[:2]):
        return None
    x, y = map(float, point[:2])
    if not 0 <= x < transform['canvas_width'] or not 0 <= y < transform['canvas_height']:
        return None
    nearest = min(candidates, key=lambda c: (c[0][0] - x)**2 + (c[0][1] - y)**2, default=None)
    tolerance = max(12., unit * transform['scale'] * transform['final_x'] * 2)
    if nearest and math.dist(nearest[0], (x, y)) <= tolerance:
        return (*nearest[1], True)
    # Y is only an estimate without a nearby detector anchor; X remains valid.
    source_x = (x / transform['final_x'] + transform['crop2'][0] + transform['crop1'][0]) / transform['scale']
    source_y = ((y - transform['padding_y']) / transform['final_y'] + transform['crop2'][1] + transform['crop1'][1]) / transform['scale']
    return source_x, source_y, False


def install_layout_hooks(parsing, generator, crop):
    systems, locations = [], {}
    original_parse = parsing.parse_staff_image
    original_note = generator.build_note_or_rest

    def parse(debug, index, staff, image, regions, config):
        # Capture the actual filtered staff and exact crop offsets used by homr.
        # Wrappers are scoped to one synchronous staff operation and restored.
        original_crop = parsing.crop_image_and_return_new_top
        original_center = parsing.center_image_on_canvas
        original_dewarp = parsing.dewarp_staff_image
        region = parsing._calculate_region(staff, regions)
        dimensions = parsing.get_tr_omr_canvas_size((int(region[3]-region[1]), int(region[2]-region[0])))
        nominal_scale = dimensions[1] / (region[3]-region[1])
        transform = {'scale': int(image.shape[1]*nominal_scale)/image.shape[1]}
        offsets = []
        warp = []

        def cropped(*args, **kwargs):
            result, offset = original_crop(*args, **kwargs)
            offsets.append(tuple(float(v) for v in offset))
            return result, offset

        def centered(source, canvas_size, margin_top=0, margin_bottom=0):
            transform.update(final_x=float(canvas_size[0])/source.shape[1],
                             final_y=float(canvas_size[1])/source.shape[0],
                             padding_y=(parsing.tr_omr_max_height-margin_top-margin_bottom-int(canvas_size[1]))//2+margin_top,
                             canvas_width=parsing.tr_omr_max_width,
                             canvas_height=parsing.tr_omr_max_height)
            return original_center(source, canvas_size, margin_top, margin_bottom)

        def dewarped(*args, **kwargs):
            result = original_dewarp(*args, **kwargs)
            warp.append(result)
            return result

        parsing.crop_image_and_return_new_top = cropped
        parsing.center_image_on_canvas = centered
        parsing.dewarp_staff_image = dewarped
        try:
            symbols = original_parse(debug, index, staff, image, regions, config)
        finally:
            parsing.crop_image_and_return_new_top = original_crop
            parsing.center_image_on_canvas = original_center
            parsing.dewarp_staff_image = original_dewarp
        if len(offsets) != 2 or 'final_x' not in transform:
            raise RuntimeError('homr-layout')
        transform.update(crop1=offsets[0], crop2=offsets[1])
        height, width = image.shape[:2]
        system = len(systems)
        if system >= 256:
            raise RuntimeError('score-limit')
        unit = float(staff.average_unit_size)
        systems.append(normalized_rect(staff.min_x, staff.min_y-2*unit,
                                       staff.max_x-staff.min_x, staff.max_y-staff.min_y+4*unit,
                                       width, height, crop))
        candidates = []
        for note in staff.get_notes():
            source = tuple(float(v) for v in note.center)
            p = tuple(v*transform['scale']-offsets[0][i] for i, v in enumerate(source))
            if warp:
                p = warp[0].dewarp_point(p)
            canvas = ((p[0]-offsets[1][0])*transform['final_x'],
                      (p[1]-offsets[1][1])*transform['final_y']+transform['padding_y'])
            candidates.append((canvas, source))
        for symbol in symbols:
            if not symbol.rhythm.startswith('note'):
                continue
            located = locate_symbol(symbol.coordinates, transform, candidates, unit)
            if located:
                x, y, snapped = located
                symbol._tixtab_location = dict(system=system, region=normalized_rect(
                    x-unit, y-unit, 2*unit, 2*unit, width, height, crop), detected=snapped)
        return symbols

    def note(model_note, *args, **kwargs):
        result = original_note(model_note, *args, **kwargs)
        location = getattr(model_note, '_tixtab_location', None)
        if location and len(locations) < 20000:
            # Identity survives chord duration sorting and voice rebalancing.
            identifier = 'tixtab-note-' + str(len(locations))
            result.id = identifier
            locations[identifier] = location
        return result

    parsing.parse_staff_image = parse
    generator.build_note_or_rest = note
    return {'systems': systems, 'noteLocations': locations}
