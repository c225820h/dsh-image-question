/**
 * Annotation -> mask raster, and the two PNG encodings downstream nodes want.
 *
 * A separate module on purpose: rasterizing and PNG-encoding are pure functions
 * over data the answer already carries, so they can be exercised without a Host,
 * an attachment service, or a route — the same reason `./token-store.js` exists.
 *
 * Zero dependencies, like the rest of the plugin: PNG is hand-encoded on top of
 * `node:zlib` (IHDR/IDAT/IEND plus a CRC table), and no image library is
 * imported. The cost is that this module can only ENCODE — it never decodes —
 * which is why the alpha variant paints a flat RGB placeholder instead of the
 * source pixels.
 *
 * Geometry follows the answer's own contract: every coordinate is a
 * `source-oriented-pixel-edge` value (x right, y down, origin top-left), and a
 * brush `width` is already in source pixels, so nothing here rescales.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { join } from 'node:path';

/** PNG signature, spelled out so a stray BOM or text mode cannot corrupt it. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Colour types this encoder emits. Both are 8-bit, no interlace, filter 0:
 * 0 = greyscale (one byte per pixel), 6 = truecolour+alpha (RGBA).
 */
const COLOR_TYPE_GREYSCALE = 0;
const COLOR_TYPE_RGBA = 6;

/**
 * The alpha variant's placeholder RGB. It exists only so the file is a valid,
 * openable RGBA image; every consumer of this variant reads the ALPHA channel,
 * where 0 marks the region to change. Keeping it a constant is what lets this
 * module stay decode-free.
 */
const ALPHA_PLACEHOLDER_RGB = [255, 255, 255];

/** Table-driven CRC-32, computed once for the PNG chunk trailer. */
const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

/** CRC-32 over one byte range, as PNG chunks require. */
function crc32(buffer) {
	let c = 0xffffffff;
	for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length, type, payload, CRC over type+payload. */
function pngChunk(type, payload) {
	const out = Buffer.alloc(12 + payload.length);
	out.writeUInt32BE(payload.length, 0);
	out.write(type, 4, 'ascii');
	payload.copy(out, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + payload.length)), 8 + payload.length);
	return out;
}

/**
 * Encode one 8-bit PNG with filter type 0 on every scanline.
 *
 * @param width - image width in pixels.
 * @param height - image height in pixels.
 * @param colorType - {@link COLOR_TYPE_GREYSCALE} or {@link COLOR_TYPE_RGBA}.
 * @param pixels - packed samples, top-to-bottom, no filter bytes.
 * @returns the complete PNG byte stream.
 */
export function encodePng(width, height, colorType, pixels) {
	const bytesPerPixel = colorType === COLOR_TYPE_RGBA ? 4 : 1;
	const stride = width * bytesPerPixel;
	const source = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
	// One filter byte (0 = None) precedes each scanline; padding each row this way
	// keeps decoding trivial for readers that do not implement filtering.
	const raw = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		const at = y * (stride + 1);
		raw[at] = 0;
		source.copy(raw, at + 1, y * stride, (y + 1) * stride);
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = colorType;
	header[10] = 0;
	header[11] = 0;
	header[12] = 0;
	return Buffer.concat([
		PNG_SIGNATURE,
		pngChunk('IHDR', header),
		pngChunk('IDAT', deflateSync(raw)),
		pngChunk('IEND', Buffer.alloc(0)),
	]);
}

/** Clamp one coordinate into `[low, high)`; a non-finite value degrades to `low`. */
function clampIndex(value, low, high) {
	if (!Number.isFinite(value)) return low;
	if (value < low) return low;
	if (value > high) return high;
	return value;
}

/** Whether a number is usable as a coordinate or a length. */
function isFiniteNumber(value) {
	return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Squared distance from one point to a segment, the primitive a round-capped
 * stroke needs: a pixel belongs to the stroke when this is within the radius.
 */
function segmentDistanceSquared(px, py, x1, y1, x2, y2) {
	const dx = x2 - x1;
	const dy = y2 - y1;
	const lengthSquared = dx * dx + dy * dy;
	let t = 0;
	if (lengthSquared > 0) {
		t = ((px - x1) * dx + (py - y1) * dy) / lengthSquared;
		if (t < 0) t = 0;
		else if (t > 1) t = 1;
	}
	const cx = x1 + t * dx;
	const cy = y1 + t * dy;
	return (px - cx) * (px - cx) + (py - cy) * (py - cy);
}

/**
 * Paint an axis-aligned rectangle, grown by `growPx` on every side.
 *
 * Growth happens HERE, in geometry, rather than as a post-pass dilation: for a
 * rectangle and a capped stroke, expanding the shape is exact and costs one
 * pass, while a dilation over the whole raster would be O(pixels x radius^2).
 */
function paintRect(raster, width, height, mark, growPx) {
	const rect = mark.rect;
	if (rect === null || typeof rect !== 'object') return;
	const { x, y, width: w, height: h } = rect;
	if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(w) || !isFiniteNumber(h)) return;
	const x0 = clampIndex(Math.floor(x - growPx), 0, width);
	const x1 = clampIndex(Math.ceil(x + w + growPx), 0, width);
	const y0 = clampIndex(Math.floor(y - growPx), 0, height);
	const y1 = clampIndex(Math.ceil(y + h + growPx), 0, height);
	for (let row = y0; row < y1; row++) raster.fill(1, row * width + x0, row * width + x1);
}

/**
 * Paint a brush stroke: a round-capped polyline whose half-width is the mark's
 * own `width` (already source pixels) plus `growPx`.
 *
 * Each segment is visited inside its own bounding box rather than swept over
 * the canvas, so the cost tracks ink actually laid down.
 */
function paintStroke(raster, width, height, mark, growPx) {
	const points = Array.isArray(mark.points) ? mark.points : [];
	const usable = points.filter((point) => point !== null && typeof point === 'object'
		&& isFiniteNumber(point.x) && isFiniteNumber(point.y));
	if (usable.length === 0) return;
	const radius = Math.max(0.5, (isFiniteNumber(mark.width) ? mark.width : 0) / 2 + growPx);
	const radiusSquared = radius * radius;
	const paint = (fromX, fromY, toX, toY) => {
		const x0 = clampIndex(Math.floor(Math.min(fromX, toX) - radius), 0, width);
		const x1 = clampIndex(Math.ceil(Math.max(fromX, toX) + radius) + 1, 0, width);
		const y0 = clampIndex(Math.floor(Math.min(fromY, toY) - radius), 0, height);
		const y1 = clampIndex(Math.ceil(Math.max(fromY, toY) + radius) + 1, 0, height);
		for (let row = y0; row < y1; row++) {
			for (let column = x0; column < x1; column++) {
				// Sample at the pixel centre so a 1px nib does not bias to one edge.
				const squared = segmentDistanceSquared(column + 0.5, row + 0.5, fromX, fromY, toX, toY);
				if (squared <= radiusSquared) raster[row * width + column] = 1;
			}
		}
	};
	if (usable.length === 1) {
		paint(usable[0].x, usable[0].y, usable[0].x, usable[0].y);
		return;
	}
	for (let i = 0; i + 1 < usable.length; i++) {
		paint(usable[i].x, usable[i].y, usable[i + 1].x, usable[i + 1].y);
	}
}

/**
 * Rasterize marks into a binary region.
 *
 * Unknown mark types are skipped rather than guessed at: a client that invents
 * a third tool must not silently produce a wrong mask.
 *
 * @param annotations - the answer's `annotations` array, verbatim.
 * @param width - source-space width in pixels.
 * @param height - source-space height in pixels.
 * @param growPx - pixels added to every mark's boundary (default 0).
 * @returns `{ raster, covered }` — `raster` is one byte per pixel, 1 = selected.
 */
export function rasterizeAnnotations(annotations, width, height, growPx = 0) {
	const raster = new Uint8Array(width * height);
	const marks = Array.isArray(annotations) ? annotations : [];
	for (const mark of marks) {
		if (mark === null || typeof mark !== 'object') continue;
		if (mark.type === 'rect') paintRect(raster, width, height, mark, growPx);
		else if (mark.type === 'brush') paintStroke(raster, width, height, mark, growPx);
	}
	let covered = 0;
	for (let i = 0; i < raster.length; i++) covered += raster[i];
	return { raster, covered };
}

/**
 * Render one binary region into the two PNG flavours consumers ask for.
 *
 * `greyscale` follows the "white = change" convention used by mask-compositing
 * and `ImageToMask`-style nodes. `rgba` follows `LoadImage`, which reads the
 * ALPHA channel and inverts it, so the region is stored TRANSPARENT.
 *
 * These two are numerically opposite; handing the wrong one downstream yields
 * an inverted mask, which is why both filenames carry their own suffix.
 *
 * @param raster - one byte per pixel, 1 = selected.
 * @param width - image width in pixels.
 * @param height - image height in pixels.
 * @returns `{ greyscale, rgba }` PNG buffers.
 */
export function encodeMaskPngs(raster, width, height) {
	const grey = new Uint8Array(width * height);
	const rgba = new Uint8Array(width * height * 4);
	for (let i = 0; i < raster.length; i++) {
		const selected = raster[i] === 1;
		grey[i] = selected ? 255 : 0;
		const at = i * 4;
		rgba[at] = ALPHA_PLACEHOLDER_RGB[0];
		rgba[at + 1] = ALPHA_PLACEHOLDER_RGB[1];
		rgba[at + 2] = ALPHA_PLACEHOLDER_RGB[2];
		rgba[at + 3] = selected ? 0 : 255;
	}
	return {
		greyscale: encodePng(width, height, COLOR_TYPE_GREYSCALE, grey),
		rgba: encodePng(width, height, COLOR_TYPE_RGBA, rgba),
	};
}

/**
 * Write the mask files one answer asked for.
 *
 * The output directory is created recursively: a model naming a fresh directory
 * is the common case, and failing on a missing parent would only cost a retry.
 *
 * @param options - output directory, filename stem, marks, source size and shape.
 * @returns the written paths plus the selected pixel count.
 */
export async function writeAnnotationMasks(options) {
	const { outDir, baseName, annotations, width, height } = options;
	const growPx = Number.isFinite(options.growPx) && options.growPx > 0 ? options.growPx : 0;
	// Defaults to the greyscale flavour: it is the one a LoadImageMask(channel="red")
	// chain reads directly, and writing one file when one file was asked for beats
	// leaving a second, numerically-opposite PNG next to it for someone to pick up
	// by mistake. The alpha flavour stays one argument away.
	const shape = options.shape === undefined ? 'gray' : options.shape;
	const { raster, covered } = rasterizeAnnotations(annotations, width, height, growPx);
	const encoded = encodeMaskPngs(raster, width, height);
	const files = shape === 'gray'
		? { greyscale: encoded.greyscale }
		: shape === 'alpha'
			? { rgba: encoded.rgba }
			: encoded;
	await mkdir(outDir, { recursive: true });
	const written = { width, height, covered_pixels: covered, grow_px: growPx };
	for (const [kind, buffer] of Object.entries(files)) {
		const path = join(outDir, `${baseName}${kind === 'rgba' ? '-alpha' : '-mask'}.png`);
		await writeFile(path, buffer);
		written[kind === 'rgba' ? 'alpha_path' : 'mask_path'] = path;
	}
	return written;
}
