// frontend/src/components/editor/TicketEditor.tsx
import React, { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import type { SeriesSlotData } from './SeriesSlot';
import { TicketToolbar } from './TicketToolbar';
import { TicketPropertiesPanel } from './TicketPropertiesPanel';
import { buildFinalRenderPayload } from '@/utils/buildFinalRenderPayload';
import { useAuth } from '@/hooks/useAuth';
import { api, apiUrl } from '@/config/api';
import { PDFDocument, StandardFonts } from 'pdf-lib';

type TicketCropMmOverride = {
  xMm: number | null;
  yMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  cutMarginMm: number | null;
  rotationDeg: number | null;
  keepProportions: boolean | null;
  alignment: 'left' | 'center' | 'right' | null;
};

interface TicketEditorProps {
  pdfUrl?: string | null;
  fileType?: 'pdf' | 'svg';
  ticketCropMm?: TicketCropMmOverride | null;
}

export type TicketOnPage = {
  seriesBySlot: Record<
    string,
    {
      seriesValue: string;
      letterStyles: { fontSize: number; offsetY: number }[];
    }
  >;
};

export type TicketOutputPage = {
  pageNumber: number;
  layoutMode: 'vector';
  ticketImageData: string;
  seriesSlots: SeriesSlotData[];
  tickets: TicketOnPage[];
};

type CustomFontSession = {
  family: string;
  dataUrl: string;
  mime: string;
};

type OverlaySession = {
  dataUrl: string;
  mime: string;
  xMm: number;
  yMm: number;
  wMm: number;
  hMm: number;
  rotationDeg: number;
};

type SvgOverlaySession = {
  type: 'svg';
  svgS3Key: string;
  svgMarkup: string;
  xMm: number;
  yMm: number;
  scale: number;
  rotationDeg: number;
  intrinsicMmW: number;
  intrinsicMmH: number;
};

export const TicketEditor: React.FC<TicketEditorProps> = ({ pdfUrl, fileType = 'pdf', ticketCropMm }: TicketEditorProps) => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { token } = useAuth();

  void pdfUrl;

  const MM_TO_PX = 3.78;
  const MAX_OBJECT_WIDTH_MM = 210;
  const MAX_OBJECT_HEIGHT_MM = 74.25;

  const [customFonts, setCustomFonts] = useState<CustomFontSession[]>([]);
  const [availableFonts, setAvailableFonts] = useState<string[]>([]);

  const [overlay, setOverlay] = useState<OverlaySession | null>(null);
  const [svgOverlay, setSvgOverlay] = useState<SvgOverlaySession | null>(null);

  const documentId = useMemo(() => {
    const raw = searchParams.get('documentId');
    const v = typeof raw === 'string' ? raw.trim() : '';
    return v || null;
  }, [searchParams]);

  const sessionToken = useMemo(() => {
    const raw = searchParams.get('sessionToken');
    const v = typeof raw === 'string' ? raw.trim() : '';
    return v || null;
  }, [searchParams]);

  const [seriesFontSizeMm] = useState(4);

  // Series config - support any characters including spaces
  const [startingSeries, setStartingSeries] = useState('A001');
  const [totalPages, setTotalPages] = useState(5);

  // Output state
  const [, setOutputPages] = useState<TicketOutputPage[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [lastPreviewId, setLastPreviewId] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);

  const [seriesSlots, setSeriesSlots] = useState<SeriesSlotData[]>([]);
  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);

  const [pdfFontCache, setPdfFontCache] = useState<Map<string, any>>(() => new Map());

  const mergedAvailableFonts = useMemo(() => {
    const uploaded = customFonts.map((f) => f.family);
    const system = (availableFonts || []).filter((f) => !uploaded.includes(f));
    return [...uploaded, ...system];
  }, [availableFonts, customFonts]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get('/api/fonts', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = Array.isArray(res.data) ? res.data : [];
        const families = data
          .map((f: any) => String(f?.family || '').trim())
          .filter((s: string) => Boolean(s));
        if (!cancelled) setAvailableFonts(families);
      } catch (e) {
        if (!cancelled) setAvailableFonts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const keys = new Set<string>();
      for (const slot of seriesSlots) {
        const name = String((slot as any)?.fontFamily || '').toLowerCase();
        if (name.includes('times')) keys.add(StandardFonts.TimesRoman);
        else if (name.includes('courier')) keys.add(StandardFonts.Courier);
        else keys.add(StandardFonts.Helvetica);
      }

      const missing = Array.from(keys).filter((k) => !pdfFontCache.has(k));
      if (!missing.length) return;

      const pdfDoc = await PDFDocument.create();
      const entries: Array<[string, any]> = [];
      for (const k of missing) {
        const font = await pdfDoc.embedFont(k as any);
        entries.push([k, font]);
      }
      if (cancelled) return;
      setPdfFontCache((prev) => {
        const next = new Map(prev);
        for (const [k, v] of entries) next.set(k, v);
        return next;
      });
    })().catch(() => {
      // ignore
    });

    return () => {
      cancelled = true;
    };
  }, [pdfFontCache, seriesSlots]);

  // Calculate ending series
  const calculateEndingSeries = useCallback((start: string, totalTickets: number): string => {
    const match = start.match(/^(.*?)(\d+)$/);
    if (match) {
      const [, prefix, numStr] = match;
      const startNum = parseInt(numStr, 10);
      const endNum = startNum + totalTickets - 1;
      return `${prefix}${endNum.toString().padStart(numStr.length, '0')}`;
    }
    return start;
  }, []);

  // 4 tickets per page
  const endingSeries = useMemo(() => calculateEndingSeries(startingSeries, totalPages * 4), [startingSeries, totalPages, calculateEndingSeries]);

  // Increment series - preserve spaces and other characters
  const incrementSeries = useCallback((value: string, increment: number): string => {
    const match = value.match(/^(.*?)(\d+)$/);
    if (match) {
      const [, prefix, numStr] = match;
      const num = parseInt(numStr, 10);
      const endNum = num + increment;
      return `${prefix}${endNum.toString().padStart(numStr.length, '0')}`;
    }
    return value;
  }, []);

  const selectedSlot = useMemo(() => {
    if (!selectedSlotId) return null;
    return seriesSlots.find((s) => s.id === selectedSlotId) ?? null;
  }, [selectedSlotId, seriesSlots]);

  useEffect(() => {
    if (!seriesSlots.length) {
      if (selectedSlotId) setSelectedSlotId(null);
      return;
    }

    if (!selectedSlotId || !seriesSlots.some((s) => s.id === selectedSlotId)) {
      setSelectedSlotId(seriesSlots[0]?.id ?? null);
    }
  }, [selectedSlotId, seriesSlots]);

  useEffect(() => {
    if (!seriesSlots.length) return;
    setSeriesSlots((prev) =>
      prev.map((slot) => {
        const desired = startingSeries;
        const newLetterStyles = desired.split('').map((_, idx) => slot.letterStyles?.[idx] || { fontSize: slot.defaultFontSize, offsetY: 0 });
        return { ...slot, value: desired, startingSeries: desired, letterStyles: newLetterStyles };
      })
    );
  }, [seriesSlots.length, startingSeries]);

  const handleAddSeriesSlot = useCallback(() => {
    const letterStyles = startingSeries.split('').map(() => ({ fontSize: 24, offsetY: 0 }));

    const stackIdx = seriesSlots.length;
    const baseX = 0.6;
    const baseY = 0.4 + stackIdx * 0.06;

    const wMm = typeof ticketCropMm?.widthMm === 'number' && Number.isFinite(ticketCropMm.widthMm) ? ticketCropMm.widthMm : null;
    const hMm = typeof ticketCropMm?.heightMm === 'number' && Number.isFinite(ticketCropMm.heightMm) ? ticketCropMm.heightMm : null;
    const xMm = typeof wMm === 'number' ? baseX * wMm : 10;
    const yMm = typeof hMm === 'number' ? baseY * hMm : 10;

    const newSlot: SeriesSlotData = {
      id: Date.now().toString(),
      x: baseX,
      y: baseY,
      x_mm: xMm,
      y_mm: yMm,
      width: 25,
      height: 12,
      value: startingSeries,
      startingSeries,
      seriesIncrement: 1,
      letterStyles,
      defaultFontSize: 24,
      fontFamily: 'Arial',
      color: '#000000',
      rotation: 0,
      backgroundColor: 'transparent',
      borderColor: '#10b981',
      borderWidth: 0,
      borderRadius: 4,
      paddingTop: 4,
      paddingBottom: 4,
      paddingLeft: 8,
      paddingRight: 8,
      textAlign: 'center',
    };

    setSeriesSlots((prev) => [...prev, newSlot]);
    setSelectedSlotId(newSlot.id);
    toast.success('Series slot added');
  }, [seriesSlots.length, startingSeries, ticketCropMm?.heightMm, ticketCropMm?.widthMm]);

  const handleDeleteSeriesSlot = useCallback(() => {
    setSeriesSlots((prev) => {
      if (!prev.length) return prev;

      const idToRemove = selectedSlotId ?? prev[prev.length - 1]?.id;
      if (!idToRemove) return prev;

      const next = prev.filter((s) => s.id !== idToRemove);

      setSelectedSlotId((prevSelected) => {
        if (prevSelected && prevSelected !== idToRemove && next.some((s) => s.id === prevSelected)) {
          return prevSelected;
        }
        return next[0]?.id ?? null;
      });

      toast.success('Series slot removed');
      return next;
    });
  }, [selectedSlotId]);

  const handleUpdateSlot = useCallback(
    (updates: Partial<SeriesSlotData>) => {
      if (!selectedSlotId) return;
      setSeriesSlots((prev) => prev.map((s) => (s.id === selectedSlotId ? { ...s, ...updates } : s)));
    },
    [selectedSlotId]
  );

  const handleUpdateLetterFontSize = useCallback(
    (index: number, fontSize: number) => {
      if (!selectedSlotId) return;
      setSeriesSlots((prev) =>
        prev.map((s) => {
          if (s.id !== selectedSlotId) return s;
          const next = [...(s.letterStyles || [])];
          next[index] = { ...(next[index] || { fontSize: s.defaultFontSize, offsetY: 0 }), fontSize };
          return { ...s, letterStyles: next };
        })
      );
    },
    [selectedSlotId]
  );

  const handleUpdateLetterOffset = useCallback(
    (index: number, offsetY: number) => {
      if (!selectedSlotId) return;
      setSeriesSlots((prev) =>
        prev.map((s) => {
          if (s.id !== selectedSlotId) return s;
          const next = [...(s.letterStyles || [])];
          next[index] = { ...(next[index] || { fontSize: s.defaultFontSize, offsetY: 0 }), offsetY };
          return { ...s, letterStyles: next };
        })
      );
    },
    [selectedSlotId]
  );

  const objectRectMm = useMemo(() => {
    const wMm = ticketCropMm?.widthMm;
    const hMm = ticketCropMm?.heightMm;

    const hasUserSizeMm =
      typeof wMm === 'number' &&
      Number.isFinite(wMm) &&
      wMm > 0 &&
      typeof hMm === 'number' &&
      Number.isFinite(hMm) &&
      hMm > 0;

    if (hasUserSizeMm) {
      const xMm = typeof ticketCropMm?.xMm === 'number' && Number.isFinite(ticketCropMm.xMm) ? ticketCropMm.xMm : 0;
      const yMm = typeof ticketCropMm?.yMm === 'number' && Number.isFinite(ticketCropMm.yMm) ? ticketCropMm.yMm : 0;
      return { xMm, yMm, widthMm: wMm as number, heightMm: hMm as number };
    }

    return null;
  }, [ticketCropMm]);

  const generateDisabledReason = useMemo(() => {
    const wMm = ticketCropMm?.widthMm;
    const hMm = ticketCropMm?.heightMm;

    if (!(typeof wMm === 'number' && Number.isFinite(wMm) && wMm > 0)) {
      return 'Missing object width (mm). Enter Width (mm) before generating.';
    }
    if (!(typeof hMm === 'number' && Number.isFinite(hMm) && hMm > 0)) {
      return 'Missing object height (mm). Enter Height (mm) before generating.';
    }

    if (Number(wMm) > MAX_OBJECT_WIDTH_MM) {
      return `Object width (${wMm}mm) exceeds max allowed (${MAX_OBJECT_WIDTH_MM}mm). Reduce width before generating.`;
    }
    if (Number(hMm) > MAX_OBJECT_HEIGHT_MM) {
      return `Object height (${hMm}mm) exceeds max allowed (${MAX_OBJECT_HEIGHT_MM}mm). Reduce height before generating.`;
    }
    return null;
  }, [MAX_OBJECT_HEIGHT_MM, MAX_OBJECT_WIDTH_MM, ticketCropMm?.heightMm, ticketCropMm?.widthMm]);

  const objectRectPx = useMemo(() => {
    if (!objectRectMm) return null;
    return {
      width: Math.max(1, Math.round(objectRectMm.widthMm * MM_TO_PX)),
      height: Math.max(1, Math.round(objectRectMm.heightMm * MM_TO_PX)),
    };
  }, [MM_TO_PX, objectRectMm]);

  const mmToPxX = useCallback(
    (mm: number) => {
      if (!objectRectMm || !objectRectPx) return mm * MM_TO_PX;
      const scale = objectRectPx.width / objectRectMm.widthMm;
      return mm * scale;
    },
    [MM_TO_PX, objectRectMm, objectRectPx]
  );

  const mmToPxY = useCallback(
    (mm: number) => {
      if (!objectRectMm || !objectRectPx) return mm * MM_TO_PX;
      const scale = objectRectPx.height / objectRectMm.heightMm;
      return mm * scale;
    },
    [MM_TO_PX, objectRectMm, objectRectPx]
  );

  const pxToMmX = useCallback(
    (px: number) => {
      if (!objectRectMm || !objectRectPx) return px / MM_TO_PX;
      const scale = objectRectPx.width / objectRectMm.widthMm;
      return px / scale;
    },
    [MM_TO_PX, objectRectMm, objectRectPx]
  );

  const pxToMmY = useCallback(
    (px: number) => {
      if (!objectRectMm || !objectRectPx) return px / MM_TO_PX;
      const scale = objectRectPx.height / objectRectMm.heightMm;
      return px / scale;
    },
    [MM_TO_PX, objectRectMm, objectRectPx]
  );

  const measureCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const measureTextWidthPx = useCallback((text: string, fontSizePx: number, fontFamily: string) => {
    const t = String(text || '');
    if (!t) return 0;
    if (!Number.isFinite(fontSizePx) || fontSizePx <= 0) return 0;

    if (!measureCtxRef.current && typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      measureCtxRef.current = canvas.getContext('2d');
    }

    const ctx = measureCtxRef.current;
    if (!ctx) {
      return t.length * fontSizePx * 0.6;
    }

    ctx.font = `${fontSizePx}px ${fontFamily || 'Arial'}`;
    return Number(ctx.measureText(t).width) || 0;
  }, []);

  const svgRawUrls = useMemo(() => {
    if (!documentId) return [] as string[];
    return [apiUrl(`/api/docs/${encodeURIComponent(documentId)}/raw-svg`)];
  }, [documentId]);

  const [svgMarkup, setSvgMarkup] = useState<string | null>(null);
  const [svgLoadError, setSvgLoadError] = useState<string | null>(null);
  const svgHostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setSvgLoadError(null);
    setSvgMarkup(null);

    if (!svgRawUrls.length) return;
    if (!sessionToken && !token) {
      setSvgLoadError('Not authenticated');
      return;
    }

    console.log('[EDITOR_PREVIEW_DOCUMENT_ID]', documentId);
    console.log('[EDITOR_PREVIEW_SVG_RAW_URLS]', svgRawUrls);
    console.log('[EDITOR_PREVIEW_SESSION_TOKEN_PRESENT]', Boolean(sessionToken));

    let revoked = false;

    void (async () => {
      try {
        const svg_s3_key = `documents/raw/${documentId}.svg`;
        const wMm = objectRectMm?.widthMm;
        const hMm = objectRectMm?.heightMm;
        if (!(typeof wMm === 'number' && Number.isFinite(wMm) && wMm > 0 && typeof hMm === 'number' && Number.isFinite(hMm) && hMm > 0)) {
          throw new Error('Missing object size (mm) for normalization');
        }

        const headers: Record<string, string> = {};
        if (sessionToken) {
          headers['X-Session-Token'] = sessionToken;
        } else if (token) {
          headers.Authorization = `Bearer ${token}`;
        }

        const res = await fetch(apiUrl('/api/normalize-svg'), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...headers,
          },
          body: JSON.stringify({
            svg_s3_key,
            object_mm: { w: wMm, h: hMm },
          }),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(text || `normalize-svg failed: ${res.status}`);
        }

        const data = (await res.json().catch(() => null)) as any;
        const normalized = typeof data?.normalized_svg === 'string' ? data.normalized_svg : '';
        if (!normalized) {
          throw new Error('normalize-svg returned empty normalized_svg');
        }

        if (revoked) return;
        setSvgMarkup(normalized);
      } catch (e) {
        console.error('normalize-svg error', e);
        if (!revoked) setSvgLoadError(e instanceof Error ? e.message : 'Unable to normalize SVG');
      }
    })();

    return () => {
      revoked = true;
    };
  }, [documentId, sessionToken, svgRawUrls, token]);

  const handleSvgClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!selectedSlotId) return;
      const host = svgHostRef.current;
      if (!host) return;
      const rect = host.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      const localY = e.clientY - rect.top;
      const xMm = pxToMmX(localX);
      const yMm = pxToMmY(localY);
      if (![xMm, yMm].every((n) => Number.isFinite(n))) return;
      setSeriesSlots((prev) => prev.map((s) => (s.id === selectedSlotId ? { ...s, x_mm: xMm, y_mm: yMm } : s)));
    },
    [pxToMmX, pxToMmY, selectedSlotId]
  );

  const handleGenerateOutput = useCallback(async () => {
    if (isGenerating) {
      toast.error('Output generation already in progress');
      return;
    }

    if (!documentId) {
      console.warn('[TicketEditor] Missing documentId in URL query params');
      toast.error('Missing documentId in URL');
      return;
    }

    setIsGenerating(true);
    setLastPreviewId(null);

    try {
      const totalTickets = totalPages * 4;

      const primaryBaseSeries = startingSeries;

      const pages: TicketOutputPage[] = Array.from({ length: Math.max(1, totalPages) }, (_, idx) => ({
        pageNumber: idx + 1,
        layoutMode: 'vector',
        ticketImageData: '',
        seriesSlots: [],
        tickets: [],
      }));

      if (pages.length === 0) {
        // eslint-disable-next-line no-console
        console.error('[handleGenerateOutput] Output pages array is empty');
        throw new Error('Output pages array is empty');
      }

      setOutputPages(pages);

      const endSeries = incrementSeries(primaryBaseSeries, totalTickets - 1);
      if (!token) throw new Error('Not authenticated');
      if (!documentId) throw new Error('Missing documentId in URL');

      if (generateDisabledReason) {
        throw new Error(generateDisabledReason);
      }
      if (fileType !== 'svg') {
        throw new Error('Vector pipeline requires SVG document');
      }
      if (!objectRectMm) {
        throw new Error('Missing object size (mm)');
      }

      const jobId = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? (crypto as any).randomUUID() : `${Date.now()}-${Math.random()}`;
      const primarySlot = selectedSlot ?? seriesSlots[0] ?? null;
      const resolvedXMm = primarySlot?.x_mm ?? null;
      const resolvedYMm = primarySlot?.y_mm ?? null;
      const resolvedRotationDeg = Number(primarySlot?.rotation ?? 0);
      const resolvedColor = String(primarySlot?.color || '#000000');
      const resolvedLetterSpacingMm = 0;
      const resolvedFontFamily = String((primarySlot as any)?.fontFamily || 'Helvetica');

      const pxToMm = (px: number) => px * 0.264583;
      const slotDefaultFontSizePx = Number(primarySlot?.defaultFontSize);
      if (!(Number.isFinite(slotDefaultFontSizePx) && slotDefaultFontSizePx > 0)) {
        throw new Error('Invalid default font size (px)');
      }
      const resolvedFontSizeMm = pxToMm(slotDefaultFontSizePx);
      const perLetterFontSizeMm = primarySlot?.value
        ? String(primarySlot.value)
            .split('')
            .map((_, idx) => {
              const px = Number(primarySlot.letterStyles?.[idx]?.fontSize ?? primarySlot.defaultFontSize);
              return Number.isFinite(px) && px > 0 ? pxToMm(px) : resolvedFontSizeMm;
            })
        : undefined;

      if (!(typeof resolvedXMm === 'number' && Number.isFinite(resolvedXMm) && typeof resolvedYMm === 'number' && Number.isFinite(resolvedYMm))) {
        throw new Error('Place series by clicking on the SVG first (missing x_mm/y_mm)');
      }

      const payload = buildFinalRenderPayload({
        jobId,
        documentId,
        objectWidthMm: objectRectMm.widthMm,
        objectHeightMm: objectRectMm.heightMm,
        objectXMm: objectRectMm.xMm,
        objectYMm: objectRectMm.yMm,
        objectAlignment: ticketCropMm?.alignment,
        objectRotationDeg: ticketCropMm?.rotationDeg,
        objectKeepProportions: ticketCropMm?.keepProportions,
        objectCutMarginMm: ticketCropMm?.cutMarginMm,
        seriesStart: primaryBaseSeries,
        seriesCount: totalPages * 4,
        seriesXMm: resolvedXMm,
        seriesYMm: resolvedYMm,
        seriesFontFamily: resolvedFontFamily,
        seriesFontSizeMm: resolvedFontSizeMm,
        perLetterFontSizeMm,
        seriesLetterSpacingMm: resolvedLetterSpacingMm,
        seriesRotationDeg: resolvedRotationDeg,
        seriesColor: resolvedColor,
        customFonts,
        overlays: overlay
          ? [
              {
                dataUrl: overlay.dataUrl,
                mime: overlay.mime,
                xMm: overlay.xMm,
                yMm: overlay.yMm,
                wMm: overlay.wMm,
                hMm: overlay.hMm,
                rotationDeg: overlay.rotationDeg,
              },
            ]
          : [],
        svgOverlays: svgOverlay
          ? [
              {
                type: 'svg' as const,
                xMm: svgOverlay.xMm,
                yMm: svgOverlay.yMm,
                scale: svgOverlay.scale,
                rotationDeg: svgOverlay.rotationDeg,
                svgS3Key: svgOverlay.svgS3Key,
              },
            ]
          : [],
      });

      console.log('[FINAL_ENGINE_PAYLOAD]', payload);

      const res = await api.post('/api/vector/generate', payload, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      const data = (res.data || {}) as any;

      const generatedJobId: string | undefined = (data as any)?.jobId;
      const pdf_s3_key: string | undefined = (data as any)?.pdf_s3_key;
      const engine_metrics: any = (data as any)?.engine_metrics;
      if (!generatedJobId) throw new Error('Missing jobId from /api/vector/generate');
      if (!pdf_s3_key) throw new Error('Missing pdf_s3_key from /api/vector/generate');

      const previewId = `${Date.now()}:${Math.random().toString(16).slice(2)}`;
      try {
        sessionStorage.setItem(
          `sph:outputPreview:${previewId}`,
          JSON.stringify({
            jobId: generatedJobId,
            pdf_s3_key,
            engine_metrics,
            pageCount: pages.length,
            pages,
            documentId,
            fileType,
          })
        );
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[handleGenerateOutput] Failed to write preview sessionStorage', e);
        throw new Error('Failed to prepare output preview');
      }

      setLastPreviewId(previewId);
      toast.success('Output generated');
      toast.success(`Generated ${pages.length} pages, ${totalTickets} tickets (${primaryBaseSeries} → ${endSeries})`);
    } catch (err) {
      console.error('Error generating output:', err);
      const eAny = err as any;
      const msg = String(eAny?.message || '').trim();
      toast.error(msg || 'Output generation failed');
    } finally {
      setIsGenerating(false);
    }
  }, [documentId, fileType, generateDisabledReason, incrementSeries, isGenerating, objectRectMm, selectedSlot, seriesSlots, startingSeries, totalPages, token]);

  const [draggingSlotId, setDraggingSlotId] = useState<string | null>(null);

  const handleSlotPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, slotId: string) => {
      e.preventDefault();
      e.stopPropagation();
      (e.currentTarget as any).setPointerCapture?.(e.pointerId);
      setSelectedSlotId(slotId);
      setDraggingSlotId(slotId);
    },
    []
  );

  const handleSlotPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingSlotId) return;
      const host = svgHostRef.current;
      if (!host) return;
      const rect = host.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      const localY = e.clientY - rect.top;
      const xMm = pxToMmX(localX);
      const yMm = pxToMmY(localY);
      if (![xMm, yMm].every((n) => Number.isFinite(n))) return;
      setSeriesSlots((prev) => prev.map((s) => (s.id === draggingSlotId ? { ...s, x_mm: xMm, y_mm: yMm } : s)));
    },
    [draggingSlotId, pxToMmX, pxToMmY]
  );

  const handleSlotPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingSlotId) return;
    e.preventDefault();
    e.stopPropagation();
    setDraggingSlotId(null);
  }, [draggingSlotId]);

  const handleViewAndPrint = useCallback(() => {
    if (!lastPreviewId) return;
    navigate(`/output-preview/${lastPreviewId}`);
  }, [lastPreviewId, navigate]);

  const handleUploadFont = useCallback((file: File | null) => {
    if (!file) return;

    const allowedTypes = [
      'font/ttf',
      'font/otf',
      'font/woff',
      'font/woff2',
      'application/x-font-ttf',
      'application/x-font-otf',
      'application/font-woff',
      'application/font-woff2',
    ];

    if (!allowedTypes.includes(file.type) && !/\.(ttf|otf|woff2?|TTF|OTF|WOFF2?)$/.test(file.name)) {
      toast.error('Upload a valid font file (.ttf, .otf, .woff, .woff2)');
      return;
    }

    const safeMime = String(file.type || '').trim() || 'application/octet-stream';

    const toBase64 = (bytes: ArrayBuffer): string => {
      const u8 = new Uint8Array(bytes);
      let s = '';
      for (let i = 0; i < u8.length; i++) {
        s += String.fromCharCode(u8[i]);
      }
      return btoa(s);
    };

    const sha256Hex8 = async (bytes: ArrayBuffer): Promise<string> => {
      if (!('crypto' in window) || !(crypto as any).subtle) {
        return String(Date.now());
      }
      const digest = await (crypto as any).subtle.digest('SHA-256', bytes);
      const arr = Array.from(new Uint8Array(digest));
      const hex = arr.map((b) => b.toString(16).padStart(2, '0')).join('');
      return hex.slice(0, 12);
    };

    void (async () => {
      try {
        const bytes = await file.arrayBuffer();
        const hash = await sha256Hex8(bytes);
        const family = `custom_font_${hash}`;
        const b64 = toBase64(bytes);
        const dataUrl = `data:${safeMime};base64,${b64}`;

        const fontFace = new (window as any).FontFace(family, `url(${dataUrl})`);
        const loaded = await fontFace.load();
        (document as any).fonts.add(loaded);

        setCustomFonts((prev) => {
          if (prev.some((f) => f.family === family)) return prev;
          return [...prev, { family, dataUrl, mime: safeMime }];
        });

        setSeriesSlots((prev) =>
          prev.map((s) => {
            if (!selectedSlotId) return s;
            if (s.id !== selectedSlotId) return s;
            return { ...s, fontFamily: family };
          })
        );

        toast.success(`Font "${family}" added`);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Error loading font:', error);
        toast.error('Failed to load font');
      }
    })();
  }, [selectedSlotId]);

  const hasValidTicketRegion = useMemo(() => true, []);

  const handleUploadImage = useCallback((file: File | null) => {
    if (!file) return;

    const allowedTypes = ['image/svg+xml', 'image/png', 'image/jpeg'];

    const lowered = file.name.toLowerCase();
    if (!allowedTypes.includes(file.type) && !/(\.svg|\.png|\.jpe?g)$/.test(lowered)) {
      toast.error('Upload SVG, PNG, or JPG image');
      return;
    }

    const safeMime = String(file.type || '').trim() || (file.name.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream');

    const pxToMm = (px: number) => px / MM_TO_PX;
    const parseSvgIntrinsicPx = (svgText: string): { wPx: number; hPx: number } | null => {
      const open = svgText.match(/<svg\b[^>]*>/i);
      const tag = open ? open[0] : '';
      if (!tag) return null;

      const vb = tag.match(/\bviewBox\s*=\s*(['"])([^'"]+)\1/i);
      if (vb) {
        const parts = String(vb[2] || '')
          .trim()
          .split(/[ ,]+/)
          .map((v) => Number(v));
        if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
          const w = parts[2];
          const h = parts[3];
          if (w > 0 && h > 0) return { wPx: w, hPx: h };
        }
      }

      const pick = (name: string) => {
        const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(['\"])([^'\"]+)\\1`, 'i'));
        return m ? String(m[2] || '').trim() : null;
      };
      const parseLenToPx = (raw: string | null) => {
        const s = typeof raw === 'string' ? raw.trim() : '';
        if (!s) return null;
        const m = s.match(/^([+-]?(?:\d+\.?\d*|\d*\.?\d+))(px|pt|mm)?$/i);
        if (!m) return null;
        const n = Number(m[1]);
        if (!Number.isFinite(n) || n <= 0) return null;
        const unit = String(m[2] || 'px').toLowerCase();
        if (unit === 'mm') return n * MM_TO_PX;
        if (unit === 'pt') return (n * 96) / 72;
        return n;
      };

      const wPx = parseLenToPx(pick('width'));
      const hPx = parseLenToPx(pick('height'));
      if (wPx && hPx) return { wPx, hPx };
      return null;
    };

    if (safeMime === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg')) {
      void (async () => {
        try {
          if (!token) {
            toast.error('Not authenticated');
            return;
          }
          const svgText = await file.text();
          const intrinsic = parseSvgIntrinsicPx(svgText);
          if (!intrinsic) {
            toast.error('Invalid SVG: missing viewBox or width/height');
            return;
          }

          const form = new FormData();
          form.append('file', file);
          const res = await api.post('/api/overlays/svg', form, {
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'multipart/form-data',
            },
          });
          const svgS3Key = String(res?.data?.svg_s3_key || '').trim();
          if (!svgS3Key) {
            toast.error('SVG upload failed');
            return;
          }

          const defaultX = 5;
          const defaultY = 5;
          setSvgOverlay({
            type: 'svg',
            svgS3Key,
            svgMarkup: svgText,
            xMm: defaultX,
            yMm: defaultY,
            scale: 1,
            rotationDeg: 0,
            intrinsicMmW: pxToMm(intrinsic.wPx),
            intrinsicMmH: pxToMm(intrinsic.hPx),
          });
          toast.success('SVG overlay added on ticket');
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error('Error uploading SVG overlay:', error);
          toast.error('Failed to upload SVG overlay');
        }
      })();
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const result = typeof e.target?.result === 'string' ? e.target.result : null;
      if (!result) {
        toast.error('Failed to read image file');
        return;
      }

      const defaultW = 20;
      const defaultX = 5;
      const defaultY = 5;
      setOverlay({ dataUrl: result, mime: safeMime, xMm: defaultX, yMm: defaultY, wMm: defaultW, hMm: defaultW, rotationDeg: 0 });
      toast.success('Image added on ticket');
    };
    reader.readAsDataURL(file);
  }, [MM_TO_PX, token]);

  const svgOverlayDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startXMm: number;
    startYMm: number;
  } | null>(null);

  const svgOverlayResizeRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    start: SvgOverlaySession;
    corner: 'nw' | 'ne' | 'sw' | 'se';
  } | null>(null);

  const handleSvgOverlayPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!svgOverlay) return;
      if ((e.target as HTMLElement)?.dataset?.corner) return;
      e.preventDefault();
      e.stopPropagation();
      svgOverlayDragRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startXMm: svgOverlay.xMm,
        startYMm: svgOverlay.yMm,
      };
      try {
        (e.currentTarget as any).setPointerCapture?.(e.pointerId);
      } catch {
      }
    },
    [svgOverlay]
  );

  const handleSvgOverlayResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, corner: 'nw' | 'ne' | 'sw' | 'se') => {
      if (!svgOverlay) return;
      e.preventDefault();
      e.stopPropagation();
      svgOverlayResizeRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        start: svgOverlay,
        corner,
      };
      try {
        (e.currentTarget as any).setPointerCapture?.(e.pointerId);
      } catch {
      }
    },
    [svgOverlay]
  );

  const handleSvgOverlayPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!svgOverlay) return;

      const d = svgOverlayDragRef.current;
      if (d && d.pointerId === e.pointerId) {
        const dxPx = e.clientX - d.startX;
        const dyPx = e.clientY - d.startY;
        const dxMm = pxToMmX(dxPx);
        const dyMm = pxToMmY(dyPx);
        if (!Number.isFinite(dxMm) || !Number.isFinite(dyMm)) return;
        setSvgOverlay((prev) => {
          if (!prev) return prev;
          return { ...prev, xMm: d.startXMm + dxMm, yMm: d.startYMm + dyMm };
        });
        return;
      }

      const r = svgOverlayResizeRef.current;
      if (r && r.pointerId === e.pointerId) {
        const dxPx = e.clientX - r.startX;
        const dyPx = e.clientY - r.startY;
        const dxMm = pxToMmX(dxPx);
        const dyMm = pxToMmY(dyPx);
        if (!Number.isFinite(dxMm) || !Number.isFinite(dyMm)) return;

        const startW = r.start.intrinsicMmW * r.start.scale;
        const startH = r.start.intrinsicMmH * r.start.scale;
        const signX = r.corner.includes('w') ? -1 : 1;
        const signY = r.corner.includes('n') ? -1 : 1;

        const nextW = Math.max(1e-6, startW + signX * dxMm);
        const nextH = Math.max(1e-6, startH + signY * dyMm);
        const scaleW = nextW / r.start.intrinsicMmW;
        const scaleH = nextH / r.start.intrinsicMmH;
        const nextScale = Math.max(0.01, Math.max(scaleW, scaleH));

        const newW = r.start.intrinsicMmW * nextScale;
        const newH = r.start.intrinsicMmH * nextScale;
        const deltaW = newW - startW;
        const deltaH = newH - startH;

        setSvgOverlay((prev) => {
          if (!prev) return prev;
          let xMm = r.start.xMm;
          let yMm = r.start.yMm;
          if (r.corner.includes('w')) xMm = r.start.xMm - deltaW;
          if (r.corner.includes('n')) yMm = r.start.yMm - deltaH;
          return { ...prev, xMm, yMm, scale: nextScale };
        });
      }
    },
    [svgOverlay, pxToMmX, pxToMmY]
  );

  const handleSvgOverlayPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = svgOverlayDragRef.current;
    if (d && d.pointerId === e.pointerId) {
      svgOverlayDragRef.current = null;
    }
    const r = svgOverlayResizeRef.current;
    if (r && r.pointerId === e.pointerId) {
      svgOverlayResizeRef.current = null;
    }
  }, []);

  const overlayDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startXMm: number;
    startYMm: number;
  } | null>(null);

  const overlayResizeRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    start: OverlaySession;
    corner: 'nw' | 'ne' | 'sw' | 'se';
  } | null>(null);

  const handleOverlayPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!overlay) return;
      if ((e.target as HTMLElement)?.dataset?.corner) return;
      e.preventDefault();
      e.stopPropagation();
      overlayDragRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startXMm: overlay.xMm,
        startYMm: overlay.yMm,
      };
      try {
        (e.currentTarget as any).setPointerCapture?.(e.pointerId);
      } catch {
      }
    },
    [overlay]
  );

  const handleOverlayResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, corner: 'nw' | 'ne' | 'sw' | 'se') => {
      if (!overlay) return;
      e.preventDefault();
      e.stopPropagation();
      overlayResizeRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        start: overlay,
        corner,
      };
      try {
        (e.currentTarget as any).setPointerCapture?.(e.pointerId);
      } catch {
      }
    },
    [overlay]
  );

  const handleOverlayPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!overlay) return;

      const d = overlayDragRef.current;
      if (d && d.pointerId === e.pointerId) {
        const dxPx = e.clientX - d.startX;
        const dyPx = e.clientY - d.startY;
        const dxMm = pxToMmX(dxPx);
        const dyMm = pxToMmY(dyPx);
        if (!Number.isFinite(dxMm) || !Number.isFinite(dyMm)) return;
        setOverlay((prev) => {
          if (!prev) return prev;
          return { ...prev, xMm: d.startXMm + dxMm, yMm: d.startYMm + dyMm };
        });
        return;
      }

      const r = overlayResizeRef.current;
      if (r && r.pointerId === e.pointerId) {
        const dxPx = e.clientX - r.startX;
        const dyPx = e.clientY - r.startY;
        const dxMm = pxToMmX(dxPx);
        const dyMm = pxToMmY(dyPx);
        if (!Number.isFinite(dxMm) || !Number.isFinite(dyMm)) return;

        const keepRatio = !e.shiftKey;
        const aspect = r.start.wMm > 0 && r.start.hMm > 0 ? r.start.wMm / r.start.hMm : 1;

        let nextWMm = r.start.wMm;
        let nextHMm = r.start.hMm;
        let nextXMm = r.start.xMm;
        let nextYMm = r.start.yMm;

        if (r.corner === 'se') {
          nextWMm = Math.max(1, r.start.wMm + dxMm);
          nextHMm = Math.max(1, r.start.hMm + dyMm);
        } else if (r.corner === 'sw') {
          nextWMm = Math.max(1, r.start.wMm - dxMm);
          nextHMm = Math.max(1, r.start.hMm + dyMm);
          nextXMm = r.start.xMm + dxMm;
        } else if (r.corner === 'ne') {
          nextWMm = Math.max(1, r.start.wMm + dxMm);
          nextHMm = Math.max(1, r.start.hMm - dyMm);
          nextYMm = r.start.yMm + dyMm;
        } else {
          nextWMm = Math.max(1, r.start.wMm - dxMm);
          nextHMm = Math.max(1, r.start.hMm - dyMm);
          nextXMm = r.start.xMm + dxMm;
          nextYMm = r.start.yMm + dyMm;
        }

        if (keepRatio) {
          const wBasedH = nextWMm / aspect;
          const hBasedW = nextHMm * aspect;
          if (Math.abs(wBasedH - nextHMm) < Math.abs(hBasedW - nextWMm)) {
            nextHMm = Math.max(1, wBasedH);
          } else {
            nextWMm = Math.max(1, hBasedW);
          }
        }

        setOverlay((prev) => {
          if (!prev) return prev;
          return { ...prev, xMm: nextXMm, yMm: nextYMm, wMm: nextWMm, hMm: nextHMm };
        });
      }
    },
    [overlay, pxToMmX, pxToMmY]
  );

  const handleOverlayPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = overlayDragRef.current;
    if (d && d.pointerId === e.pointerId) {
      overlayDragRef.current = null;
    }
    const r = overlayResizeRef.current;
    if (r && r.pointerId === e.pointerId) {
      overlayResizeRef.current = null;
    }
  }, []);

  if (!documentId) {
    console.warn('[TicketEditor] Missing documentId in URL query params');
    return (
      <div className="h-full w-full flex items-center justify-center bg-background">
        <div className="text-sm text-destructive">Missing documentId in URL</div>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-1 min-w-0 w-full h-full bg-background overflow-hidden">
        {/* Left Toolbar */}
        <TicketToolbar
          hasSeriesSlot={seriesSlots.length > 0}
          hasTicketRegion={true}
          hasValidTicketRegion={hasValidTicketRegion}
          generateDisabledReason={generateDisabledReason}
          startingSeries={startingSeries}
          endingSeries={endingSeries}
          totalPages={totalPages}
          isGenerating={isGenerating}
          onAddSeriesSlot={handleAddSeriesSlot}
          onDeleteSeriesSlot={handleDeleteSeriesSlot}
          onStartingSeriesChange={setStartingSeries}
          onTotalPagesChange={setTotalPages}
          onGenerateOutput={handleGenerateOutput}
          lastPreviewId={lastPreviewId}
          onViewAndPrint={handleViewAndPrint}
          onUploadFont={(f: File) => handleUploadFont(f)}
          onUploadImage={(f: File) => handleUploadImage(f)}
        />

        {/* Center */}
        <div ref={containerRef} className="flex-1 min-w-0 relative bg-muted/30 overflow-auto">
          <div className="h-full w-full flex items-center justify-center p-6">
            {svgLoadError ? (
              <div className="text-sm text-destructive">{svgLoadError}</div>
            ) : svgMarkup ? (
              <div
                className="relative bg-white"
                style={{
                  width: objectRectPx?.width ?? 800,
                  height: objectRectPx?.height ?? 450,
                  border: '1px solid rgba(0,0,0,0.15)',
                }}
              >
                <div
                  ref={svgHostRef}
                  className="absolute inset-0 h-full w-full z-0"
                  onClick={handleSvgClick}
                  style={{ maxWidth: '100%', maxHeight: '100%', pointerEvents: 'auto' }}
                  dangerouslySetInnerHTML={{ __html: svgMarkup }}
                />

                {svgOverlay && objectRectPx && objectRectMm ? (
                  <div
                    className="absolute z-20"
                    onPointerDown={handleSvgOverlayPointerDown}
                    onPointerMove={handleSvgOverlayPointerMove}
                    onPointerUp={handleSvgOverlayPointerUp}
                    style={{
                      left: mmToPxX(svgOverlay.xMm),
                      top: mmToPxY(svgOverlay.yMm),
                      width: mmToPxX(svgOverlay.intrinsicMmW),
                      height: mmToPxY(svgOverlay.intrinsicMmH),
                      transform: `rotate(${svgOverlay.rotationDeg}deg) scale(${svgOverlay.scale})`,
                      transformOrigin: 'center',
                      cursor: 'move',
                      userSelect: 'none',
                      pointerEvents: 'auto',
                    }}
                  >
                    <div
                      style={{ width: '100%', height: '100%', pointerEvents: 'none' }}
                      dangerouslySetInnerHTML={{ __html: svgOverlay.svgMarkup }}
                    />

                    {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => {
                      const isTop = corner.includes('n');
                      const isLeft = corner.includes('w');
                      return (
                        <div
                          key={corner}
                          data-corner={corner}
                          onPointerDown={(e) => handleSvgOverlayResizePointerDown(e, corner)}
                          style={{
                            position: 'absolute',
                            width: 10,
                            height: 10,
                            background: '#3b82f6',
                            borderRadius: 2,
                            top: isTop ? -5 : undefined,
                            bottom: !isTop ? -5 : undefined,
                            left: isLeft ? -5 : undefined,
                            right: !isLeft ? -5 : undefined,
                            cursor: `${corner}-resize`,
                            pointerEvents: 'auto',
                          }}
                        />
                      );
                    })}
                  </div>
                ) : null}

                {overlay && objectRectPx && objectRectMm ? (
                  <div
                    className="absolute z-20"
                    onPointerDown={handleOverlayPointerDown}
                    onPointerMove={handleOverlayPointerMove}
                    onPointerUp={handleOverlayPointerUp}
                    style={{
                      left: mmToPxX(overlay.xMm),
                      top: mmToPxY(overlay.yMm),
                      width: mmToPxX(overlay.wMm),
                      height: mmToPxY(overlay.hMm),
                      transform: `rotate(${overlay.rotationDeg}deg)`,
                      transformOrigin: 'top left',
                      cursor: 'move',
                      userSelect: 'none',
                      pointerEvents: 'auto',
                      boxSizing: 'border-box',
                      border: '1px dashed rgba(59, 130, 246, 0.9)',
                      background: 'rgba(59, 130, 246, 0.06)',
                    }}
                  >
                    <img
                      src={overlay.dataUrl}
                      alt="overlay"
                      draggable={false}
                      style={{ width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none' }}
                    />

                    {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => {
                      const isTop = corner.includes('n');
                      const isLeft = corner.includes('w');
                      return (
                        <div
                          key={corner}
                          data-corner={corner}
                          onPointerDown={(e) => handleOverlayResizePointerDown(e, corner)}
                          style={{
                            position: 'absolute',
                            width: 10,
                            height: 10,
                            background: '#3b82f6',
                            borderRadius: 2,
                            top: isTop ? -5 : undefined,
                            bottom: !isTop ? -5 : undefined,
                            left: isLeft ? -5 : undefined,
                            right: !isLeft ? -5 : undefined,
                            cursor: 'nwse-resize',
                            pointerEvents: 'auto',
                          }}
                        />
                      );
                    })}
                  </div>
                ) : null}

                {seriesSlots
                  .filter((slot) => typeof slot.x_mm === 'number' && Number.isFinite(slot.x_mm) && typeof slot.y_mm === 'number' && Number.isFinite(slot.y_mm))
                  .map((slot) => {
                    const anchorX = mmToPxX(Number(slot.x_mm));
                    const anchorBaselineY = mmToPxY(Number(slot.y_mm));
                    const ghostText = String(slot.startingSeries || startingSeries);

                    const name = String((slot as any)?.fontFamily || '').toLowerCase();
                    const fontKey = name.includes('times') ? StandardFonts.TimesRoman : name.includes('courier') ? StandardFonts.Courier : StandardFonts.Helvetica;
                    const pdfFont = pdfFontCache.get(fontKey);
                    if (!pdfFont) return null;

                    const rot = Number((slot as any).rotation_deg ?? slot.rotation ?? 0);
                    const isSelected = selectedSlotId === slot.id;

                    const glyphs = String(ghostText).split('').map((ch, i) => {
                      const rawSize = Number((slot as any).letterStyles?.[i]?.fontSize ?? (slot as any).defaultFontSize ?? 24);
                      const size = Number.isFinite(rawSize) && rawSize > 0 ? rawSize : 24;
                      const rawOffset = Number((slot as any).letterStyles?.[i]?.offsetY ?? 0);
                      const offsetY = Number.isFinite(rawOffset) ? rawOffset : 0;
                      const ascent = Number(pdfFont.heightAtSize(size, { descender: false }));
                      const advance = Number(pdfFont.widthOfTextAtSize(ch, size));
                      return {
                        ch,
                        size,
                        offsetY,
                        ascent: Number.isFinite(ascent) ? ascent : 0,
                        advance: Number.isFinite(advance) ? advance : 0,
                      };
                    });

                    let cursorX = 0;
                    const positioned = glyphs.map((g) => {
                      const x = cursorX;
                      cursorX += g.advance;
                      return { ...g, x };
                    });

                    const textWidth = Math.max(1, cursorX);
                    const baselineGuideY = 0;

                    return (
                      <div
                        key={slot.id}
                        className="series-slot-preview"
                        onPointerDown={(e) => handleSlotPointerDown(e, slot.id)}
                        onPointerMove={handleSlotPointerMove}
                        onPointerUp={handleSlotPointerUp}
                        style={{
                          position: 'absolute',
                          left: anchorX,
                          top: anchorBaselineY,
                          width: Math.max(20, textWidth),
                          height: 1,
                          transform: `rotate(${rot}deg)`,
                          transformOrigin: '0px 0px',
                          pointerEvents: 'auto',
                          zIndex: isSelected ? 20 : 10,
                        }}
                      >
                        <div
                          style={{
                            position: 'absolute',
                            left: 0,
                            top: baselineGuideY,
                            width: Math.max(20, textWidth),
                            height: 1,
                            background: 'rgba(34, 197, 94, 0.9)',
                            pointerEvents: 'none',
                          }}
                        />
                        <div
                          style={{
                            position: 'absolute',
                            left: -5,
                            top: -5,
                            width: 11,
                            height: 11,
                            pointerEvents: 'none',
                          }}
                        >
                          <div style={{ position: 'absolute', left: 5, top: 0, width: 1, height: 11, background: 'rgba(34, 197, 94, 0.95)' }} />
                          <div style={{ position: 'absolute', left: 0, top: 5, width: 11, height: 1, background: 'rgba(34, 197, 94, 0.95)' }} />
                        </div>

                        {positioned.map((g, i) => {
                          const drawCh = g.ch === ' ' ? '\u00A0' : g.ch;
                          return (
                            <span
                              key={i}
                              style={{
                                position: 'absolute',
                                left: g.x,
                                top: baselineGuideY - g.ascent + g.offsetY,
                                fontFamily: String((slot as any).fontFamily || 'Arial'),
                                fontSize: g.size,
                                color: String((slot as any).color || 'rgba(0,0,0,0.6)'),
                                whiteSpace: 'pre',
                                lineHeight: '1',
                                pointerEvents: 'none',
                                userSelect: 'none',
                              }}
                            >
                              {drawCh}
                            </span>
                          );
                        })}
                      </div>
                    );
                  })}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">Loading SVG…</div>
            )}
          </div>

          {objectRectPx && objectRectMm ? (
            <div className="absolute left-1/2 top-1/2 z-10" style={{ transform: 'translate(-50%, -50%)', pointerEvents: 'none' }}>
              <div
                style={{
                  width: objectRectPx.width,
                  height: objectRectPx.height,
                  border: '2px dashed #4f8cff',
                  boxSizing: 'border-box',
                }}
              >
                <div className="absolute left-2 top-2 rounded bg-white/80 px-2 py-1 text-[12px] text-black">
                  {Math.round(objectRectMm.widthMm * 100) / 100}mm × {Math.round(objectRectMm.heightMm * 100) / 100}mm
                </div>
              </div>
            </div>
          ) : null}

        </div>

        {/* Right Properties Panel */}
        <aside className="w-80 border-l overflow-y-auto">
          <TicketPropertiesPanel
            slot={selectedSlot}
            onUpdateSlot={handleUpdateSlot}
            onUpdateLetterFontSize={handleUpdateLetterFontSize}
            onUpdateLetterOffset={handleUpdateLetterOffset}
            availableFonts={mergedAvailableFonts}
          />
        </aside>
      </div>

      {/* Output Preview is now a dedicated route: /output-preview */}
    </>
  );
};

export default TicketEditor;
