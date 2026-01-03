export type FinalRenderPayload = {
  job_id: string;
  svg_s3_key: string;
  custom_fonts?: {
    family: string;
    data_url: string;
    mime: string;
  }[];
  overlays?: (
    | {
        data_url: string;
        mime: string;
        x_mm: number;
        y_mm: number;
        w_mm: number;
        h_mm: number;
        rotation_deg: number;
      }
    | {
        type: 'svg';
        x_mm: number;
        y_mm: number;
        scale: number;
        rotation_deg: number;
        svg_s3_key: string;
      }
  )[];
  object_mm: {
    w: number;
    h: number;
    x_mm: number | null;
    y_mm: number | null;
    alignment: 'left' | 'center' | 'right';
    rotation_deg: number;
    keep_proportions: boolean;
    cut_margin_mm: number;
  };
  series: {
    start: string;
    count: number;
    font_family: string;
    font_size_mm: number;
    per_letter_font_size_mm?: number[];
    anchor_space: 'object_mm';
    x_mm: number;
    y_mm: number;
    letter_spacing_mm: number;
    rotation_deg: number;
    color: string;
  };
};

const toFiniteNumberOrNull = (raw: unknown): number | null => {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

export function buildFinalRenderPayload(params: {
  jobId: string;
  documentId: string;
  objectWidthMm: unknown;
  objectHeightMm: unknown;
  objectXMm: unknown;
  objectYMm: unknown;
  objectAlignment: unknown;
  objectRotationDeg: unknown;
  objectKeepProportions: unknown;
  objectCutMarginMm: unknown;
  seriesStart: string;
  seriesCount: number;
  seriesXMm?: unknown;
  seriesYMm?: unknown;
  seriesFontFamily: string;
  seriesFontSizeMm: number;
  perLetterFontSizeMm?: number[];
  seriesLetterSpacingMm: number;
  seriesRotationDeg: number;
  seriesColor: string;
  customFonts?: { family: string; dataUrl: string; mime: string }[];
  overlays?: { dataUrl: string; mime: string; xMm: number; yMm: number; wMm: number; hMm: number; rotationDeg: number }[];
  svgOverlays?: { type: 'svg'; xMm: number; yMm: number; scale: number; rotationDeg: number; svgS3Key: string }[];
}): FinalRenderPayload {
  const job_id = String(params.jobId || '').trim();
  if (!job_id) throw new Error('job_id is required');

  const documentId = String(params.documentId || '').trim();
  if (!documentId) throw new Error('documentId is required');

  const w = toFiniteNumberOrNull(params.objectWidthMm);
  const h = toFiniteNumberOrNull(params.objectHeightMm);
  if (!(w !== null && w > 0 && h !== null && h > 0)) {
    throw new Error('object_mm.w and object_mm.h are required and must be > 0');
  }

  const x_mm = toFiniteNumberOrNull(params.objectXMm);
  const y_mm = toFiniteNumberOrNull(params.objectYMm);

  const alignmentRaw = String(params.objectAlignment || '').trim().toLowerCase();
  const alignment: 'left' | 'center' | 'right' =
    alignmentRaw === 'left' || alignmentRaw === 'right' || alignmentRaw === 'center' ? (alignmentRaw as any) : 'center';

  const rotationDegRaw = Number(params.objectRotationDeg);
  const rotation_deg = Number.isFinite(rotationDegRaw) ? rotationDegRaw : 0;

  const keep_proportions = typeof params.objectKeepProportions === 'boolean' ? params.objectKeepProportions : false;

  const cutMarginRaw = Number(params.objectCutMarginMm);
  const cut_margin_mm = Number.isFinite(cutMarginRaw) && cutMarginRaw >= 0 ? cutMarginRaw : 0;

  const seriesStart = String(params.seriesStart || '');
  if (!seriesStart) throw new Error('series.start is required');

  const count = Number(params.seriesCount);
  if (!(Number.isFinite(count) && count > 0)) {
    throw new Error('series.count is required and must be > 0');
  }

  const xMm = toFiniteNumberOrNull((params as any).seriesXMm);
  const yMm = toFiniteNumberOrNull((params as any).seriesYMm);
  const hasMm = xMm !== null && yMm !== null;

  if (!hasMm) {
    throw new Error('series requires object_mm coordinates (missing seriesXMm/seriesYMm)');
  }

  const font_family = String(params.seriesFontFamily || '');
  if (!font_family) {
    throw new Error('series.font_family is required');
  }

  const font_size_mm = Number(params.seriesFontSizeMm);
  if (!(Number.isFinite(font_size_mm) && font_size_mm > 0)) {
    throw new Error('series.font_size_mm must be a number > 0');
  }

  const per_letter_font_size_mm = Array.isArray(params.perLetterFontSizeMm)
    ? params.perLetterFontSizeMm.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0)
    : null;

  const letter_spacing_mm = Number(params.seriesLetterSpacingMm);
  if (!Number.isFinite(letter_spacing_mm)) {
    throw new Error('series.letter_spacing_mm must be a number');
  }

  const series_rotation_deg = Number(params.seriesRotationDeg);
  if (!Number.isFinite(series_rotation_deg)) {
    throw new Error('series.rotation_deg must be a number');
  }

  const color = String(params.seriesColor || '').trim();
  if (!color) {
    throw new Error('series.color is required');
  }

  // SVG uploads are stored by backend at documents/raw/{documentId}.svg
  const svg_s3_key = `documents/raw/${documentId}.svg`;

  const custom_fonts = Array.isArray(params.customFonts)
    ? params.customFonts
        .map((f) => ({
          family: String((f as any)?.family || ''),
          data_url: String((f as any)?.dataUrl || ''),
          mime: String((f as any)?.mime || ''),
        }))
        .filter((f) => Boolean(f.family) && Boolean(f.data_url))
    : undefined;

  const imageOverlays = Array.isArray(params.overlays)
    ? params.overlays
        .map((o) => ({
          data_url: String((o as any)?.dataUrl || ''),
          mime: String((o as any)?.mime || ''),
          x_mm: Number((o as any)?.xMm),
          y_mm: Number((o as any)?.yMm),
          w_mm: Number((o as any)?.wMm),
          h_mm: Number((o as any)?.hMm),
          rotation_deg: Number((o as any)?.rotationDeg),
        }))
        .filter(
          (o) =>
            Boolean(o.data_url) &&
            Number.isFinite(o.x_mm) &&
            Number.isFinite(o.y_mm) &&
            Number.isFinite(o.w_mm) &&
            Number.isFinite(o.h_mm) &&
            o.w_mm > 0 &&
            o.h_mm > 0 &&
            Number.isFinite(o.rotation_deg)
        )
    : [];

  const svgOverlays = Array.isArray(params.svgOverlays)
    ? params.svgOverlays
        .map((o) => ({
          type: 'svg' as const,
          x_mm: Number((o as any)?.xMm),
          y_mm: Number((o as any)?.yMm),
          scale: Number((o as any)?.scale),
          rotation_deg: Number((o as any)?.rotationDeg),
          svg_s3_key: String((o as any)?.svgS3Key || ''),
        }))
        .filter(
          (o) =>
            Number.isFinite(o.x_mm) &&
            Number.isFinite(o.y_mm) &&
            Number.isFinite(o.scale) &&
            o.scale > 0 &&
            Number.isFinite(o.rotation_deg) &&
            Boolean(o.svg_s3_key)
        )
    : [];

  const overlays = [...imageOverlays, ...svgOverlays];

  return {
    job_id,
    svg_s3_key,
    ...(custom_fonts && custom_fonts.length ? { custom_fonts } : {}),
    ...(overlays && overlays.length ? { overlays } : {}),
    object_mm: {
      w,
      h,
      x_mm,
      y_mm,
      alignment,
      rotation_deg,
      keep_proportions,
      cut_margin_mm,
    },
    series: {
      start: seriesStart,
      count,
      font_family,
      font_size_mm,
      ...(per_letter_font_size_mm && per_letter_font_size_mm.length ? { per_letter_font_size_mm } : {}),
      anchor_space: 'object_mm',
      x_mm: xMm,
      y_mm: yMm,
      letter_spacing_mm,
      rotation_deg: series_rotation_deg,
      color,
    },
  };
}
