import { useState, useEffect, useCallback, useMemo, useRef } from 'react';

import { useLocation, Navigate, Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Shield, ArrowLeft, AlertCircle, Printer, Eye } from 'lucide-react';
import { SecurePrintDialog } from '@/components/SecurePrintDialog';
import { TicketEditor } from '@/components/editor/TicketEditor';
import { DocumentPreview } from '@/components/editor/DocumentPreview';

import { Button } from '@/components/ui/button';

import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';

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

type ViewerNavState = {
  sessionToken?: string;
  documentTitle?: string;
  documentId?: string;
  documentType?: 'pdf' | 'svg';
  remainingPrints?: number;
  maxPrints?: number;
  ticketCropMm?: TicketCropMmOverride | null;
};

type SecureRenderStatus = 'CREATED' | 'BATCH_RUNNING' | 'MERGE_RUNNING' | 'READY' | 'FAILED';

type SecureRenderResponse = {
  status: SecureRenderStatus;
  canRetry: boolean;
  retryAfterMs: number;
  errorCode: string | null;
};

type DebugTimelineEntry = {
  at: string;
  status: SecureRenderStatus;
};

const Viewer = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const state = (location.state || {}) as ViewerNavState;
  const sessionToken = searchParams.get('sessionToken') ?? undefined;

  const documentTitle = state.documentTitle ?? searchParams.get('documentTitle') ?? undefined;
  const documentId = searchParams.get('documentId') ?? undefined;
  const documentType = useMemo(() => {
    const raw = searchParams.get('documentType') ?? state.documentType;
    return raw === 'svg' ? 'svg' : 'pdf';
  }, [searchParams, state.documentType]);
  const ticketCropMmFromState = state.ticketCropMm ?? undefined;

  const initialPrintsRaw = state.remainingPrints ?? searchParams.get('remainingPrints');
  const maxPrintsRaw = state.maxPrints ?? searchParams.get('maxPrints');
  const initialPrints = Number.parseInt(String(initialPrintsRaw ?? '0'), 10) || 0;
  const maxPrints = Number.parseInt(String(maxPrintsRaw ?? '0'), 10) || 0;
  const { user } = useAuth();

  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remainingPrints, setRemainingPrints] = useState(initialPrints || 0);

  const [secureRender, setSecureRender] = useState<SecureRenderResponse | null>(null);
  const [secureRenderTerminalError, setSecureRenderTerminalError] = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryLocked, setRetryLocked] = useState(false);

  const [stillWorking, setStillWorking] = useState(false);
  const stillWorkingTimeoutRef = useRef<number | null>(null);

  const [debugTimeline, setDebugTimeline] = useState<DebugTimelineEntry[]>([]);
  const lastTimelineStatusRef = useRef<SecureRenderStatus | null>(null);

  const [isPrinting, setIsPrinting] = useState(false);
  const [showPrintDialog, setShowPrintDialog] = useState(false);

  const inFlightRef = useRef(false);

  const debugEnabled = searchParams.get('debug') === '1';

  const pdfObjectUrlRef = useRef<string | null>(null);

  const shouldRedirect = !sessionToken;

  const ticketCropMm = useMemo(() => {
    if (ticketCropMmFromState) return ticketCropMmFromState;
    if (!documentId) return null;
    try {
      const raw = sessionStorage.getItem(`ticketCropMm:${documentId}`);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }, [documentId, ticketCropMmFromState]);

  const fetchSecureRenderPdf = useCallback(async () => {
    if (!sessionToken) return;
    if (inFlightRef.current) return;

    inFlightRef.current = true;
    setSecureRenderTerminalError(null);

    const requestIdKey = sessionToken ? `secure-render:${sessionToken}` : 'secure-render:unknown';
    let stableRequestId = '';

    try {
      stableRequestId = sessionStorage.getItem(requestIdKey) || '';
      if (!stableRequestId) {
        stableRequestId = crypto.randomUUID();
        sessionStorage.setItem(requestIdKey, stableRequestId);
      }
    } catch {
      stableRequestId = crypto.randomUUID();
    }

    try {
      const res = await fetch('/api/docs/secure-render', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Request-Id': stableRequestId,
        },
        body: JSON.stringify({ sessionToken, requestId: stableRequestId }),
      });

      if (res.status === 409) {
        setSecureRenderTerminalError('Document is still preparing. Please wait…');
        return;
      }

      if (res.status === 404) {
        setSecureRenderTerminalError('Document not found');
        return;
      }

      if (res.status === 403) {
        setSecureRenderTerminalError('Access revoked');
        return;
      }

      if (res.status !== 200) {
        setSecureRenderTerminalError('Failed to fetch document');
        return;
      }

      const contentType = res.headers.get('content-type');
      if (!contentType || !contentType.includes('application/pdf')) {
        setSecureRenderTerminalError('Unexpected response from server');
        return;
      }

      const blob = await res.blob();

      if (pdfObjectUrlRef.current) {
        try {
          URL.revokeObjectURL(pdfObjectUrlRef.current);
        } catch {
          // ignore
        }
      }
      const url = URL.createObjectURL(blob);
      pdfObjectUrlRef.current = url;
      setPdfUrl(url);
      setSecureRender({ status: 'READY', canRetry: false, retryAfterMs: 0, errorCode: null });
    } catch (e) {
      const eAny = e as any;
      const msg = String(eAny?.message || '').trim();
      setSecureRenderTerminalError(msg || 'Failed to fetch document');
    } finally {
      inFlightRef.current = false;
    }
  }, [sessionToken]);

  const handleRetry = useCallback(async () => {
    if (!sessionToken) return;
    if (isRetrying) return;
    if (retryLocked) return;

    try {
      setIsRetrying(true);
      setRetryLocked(true);
      await fetchSecureRenderPdf();
    } finally {
      setIsRetrying(false);
    }
  }, [fetchSecureRenderPdf, isRetrying, retryLocked, sessionToken]);

  useEffect(() => {
    setSecureRender(null);
    setSecureRenderTerminalError(null);
    setError(null);

    if (pdfObjectUrlRef.current) {
      try {
        URL.revokeObjectURL(pdfObjectUrlRef.current);
      } catch {
        // ignore
      }
      pdfObjectUrlRef.current = null;
    }
    setPdfUrl(null);

    if (!sessionToken) {
      return;
    }

    return () => {
      if (pdfObjectUrlRef.current) {
        try {
          URL.revokeObjectURL(pdfObjectUrlRef.current);
        } catch {
          // ignore
        }
        pdfObjectUrlRef.current = null;
      }
    };
  }, [sessionToken]);

  useEffect(() => {
    if (secureRender?.status && secureRender.status !== 'FAILED') {
      setRetryLocked(false);
    }
  }, [secureRender?.status]);

  const errorCodeHuman = useMemo(() => {
    if (secureRender?.status !== 'FAILED') return null;
    const code = String(secureRender?.errorCode || 'UNKNOWN').trim().toUpperCase();
    if (!code) return 'Unknown error';
    const map: Record<string, string> = {
      HMAC_FAILED: 'Security check failed',
      TIMEOUT: 'Timed out',
      MERGE_FAIL: 'Failed to merge pages',
      INKSCAPE_FAIL: 'Vector conversion failed',
      SVG_TOO_COMPLEX: 'SVG too complex to process',
      INVALID_INPUT: 'Invalid input',
      INVALID_OUTPUT: 'Invalid output produced',
      NORMALIZE_FAILED: 'Normalization failed',
      JOB_FAILED: 'Job failed',
      UNKNOWN: 'Unknown error',
    };
    return map[code] || `Error: ${code}`;
  }, [secureRender?.errorCode, secureRender?.status]);

  const statusMessage = useMemo(() => {
    const st = secureRender?.status;
    if (!st) return null;
    if (st === 'CREATED') return 'Preparing document…';
    if (st === 'BATCH_RUNNING') return 'Rendering pages…';
    if (st === 'MERGE_RUNNING') return 'Finalizing PDF…';
    if (st === 'READY') return 'Document ready';
    if (st === 'FAILED') return 'Rendering failed';
    return null;
  }, [secureRender?.status]);

  const previewDisabled = !sessionToken;

  const showIndeterminateProgress =
    secureRender?.status === 'CREATED' || secureRender?.status === 'BATCH_RUNNING' || secureRender?.status === 'MERGE_RUNNING';

  const handleCancel = useCallback(() => {
    navigate('/upload');
  }, [navigate]);

  const handlePrintClick = () => {
    if (remainingPrints > 0) {
      setShowPrintDialog(true);
    } else {
      toast.error('Print limit exceeded');
    }
  };

  const handleConfirmPrint = useCallback(async () => {
    if (remainingPrints <= 0) {
      toast.error('Print limit exceeded');
      return;
    }

    setIsPrinting(true);

    try {
      const res = await fetch('/api/docs/secure-print', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionToken }),
      });

      const data = (await res.json().catch(() => null)) as any;
      if (!res.ok) {
        const msg = String(data?.message || '').trim();
        throw new Error(msg || `Print failed: ${res.status}`);
      }

      const pdfUrlForPrint = String(data?.fileUrl || '').trim();
      if (!pdfUrlForPrint) {
        throw new Error('Missing fileUrl from /api/docs/secure-print');
      }

      const newRemaining = data.remainingPrints ?? remainingPrints - 1;
      setRemainingPrints(newRemaining);

      const printWindow = window.open('', '_blank', 'width=900,height=700');
      if (printWindow) {
        printWindow.document.write(`
          <!DOCTYPE html>
          <html>
            <head>
              <title>Secure Print - ${documentTitle}</title>
              <style>
                html, body { margin: 0; padding: 0; height: 100%; width: 100%; }
                iframe { border: 0; width: 100%; height: 100%; }
              </style>
            </head>
            <body oncontextmenu="return false" ondragstart="return false">
              <iframe id="printFrame" src="${pdfUrlForPrint}"></iframe>
              <script>
                const iframe = document.getElementById('printFrame');
                iframe.onload = function () {
                  try {
                    iframe.contentWindow.focus();
                    iframe.contentWindow.print();
                  } catch (e) {
                    console.error('Print failed', e);
                  }
                };
              </script>
            </body>
          </html>
        `);
        printWindow.document.close();
      }

      setShowPrintDialog(false);
      toast.success(`Print ready. ${newRemaining} prints remaining.`);
    } catch (err) {
      console.error('Print error:', err);
      toast.error(err instanceof Error ? err.message : 'Print failed');
    } finally {
      setIsPrinting(false);
    }
  }, [documentTitle, remainingPrints, sessionToken]);

  const secureRenderLastUpdatedAt = (secureRender as any)?.lastUpdatedAt ?? null;
  const stillWorkingKey = useMemo(() => {
    const st = secureRender?.status ?? '';
    const lu = secureRenderLastUpdatedAt ? String(secureRenderLastUpdatedAt) : '';
    return `${st}:${lu}`;
  }, [secureRender?.status, secureRenderLastUpdatedAt]);

  useEffect(() => {
    if (stillWorkingTimeoutRef.current !== null) {
      window.clearTimeout(stillWorkingTimeoutRef.current);
      stillWorkingTimeoutRef.current = null;
    }
    setStillWorking(false);

    const st = secureRender?.status;
    if (st === 'CREATED' || st === 'BATCH_RUNNING' || st === 'MERGE_RUNNING') {
      stillWorkingTimeoutRef.current = window.setTimeout(() => {
        setStillWorking(true);
      }, 120_000);
    }

    return () => {
      if (stillWorkingTimeoutRef.current !== null) {
        window.clearTimeout(stillWorkingTimeoutRef.current);
        stillWorkingTimeoutRef.current = null;
      }
    };
  }, [stillWorkingKey, secureRender?.status]);

  useEffect(() => {
    setDebugTimeline([]);
    lastTimelineStatusRef.current = null;
  }, [sessionToken]);

  useEffect(() => {
    const st = secureRender?.status;
    if (!st) return;
    if (lastTimelineStatusRef.current === st) return;
    lastTimelineStatusRef.current = st;

    const at = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    setDebugTimeline((prev) => [...prev, { at, status: st }]);
  }, [secureRender?.status]);

  if (shouldRedirect) {
    return <Navigate to="/upload" replace />;
  }

  if (!documentId) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-background">
        <div className="text-sm text-destructive">Missing documentId in URL</div>
      </div>
    );
  }

  return (
    <div
      className="h-screen flex flex-col bg-background"

      // Disable right-click so user context menu se save / print na kare
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Compact Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-card/50 flex-shrink-0">
        <Link
          to="/upload"
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          <span>Back</span>
        </Link>
        <div className="flex items-center gap-4">
          <div className="flex flex-col items-end">
            <span className="text-xs text-muted-foreground truncate max-w-[220px]">{documentTitle}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 text-primary">
              <Shield className="h-4 w-4" />
              <span className="text-xs font-medium">Protected</span>
            </div>
            <Button
              size="sm"
              variant="default"
              className="gap-2"
              disabled={remainingPrints <= 0}
              onClick={handlePrintClick}
            >
              <Printer className="h-4 w-4" />
              {remainingPrints > 0 ? 'Print' : 'No Prints Left'}
            </Button>

            <Button
              size="sm"
              variant="outline"
              className="gap-2"
              disabled={previewDisabled}
              onClick={() => {
                if (pdfUrl) return window.open(pdfUrl, '_blank', 'noopener,noreferrer');
                void fetchSecureRenderPdf();
              }}
            >
              <Eye className="h-4 w-4" />
              Preview
            </Button>

            {showIndeterminateProgress ? (
              <Button size="sm" variant="outline" onClick={handleCancel}>
                Cancel (job will continue in background)
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="px-4 py-2 border-b border-border bg-muted/20 flex-shrink-0">
        <div className="flex items-center gap-2 text-xs">
          {showIndeterminateProgress ? (
            <span
              className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent"
              aria-label="Loading"
            />
          ) : null}
          {statusMessage ? (
            <span className={secureRender?.status === 'FAILED' ? 'text-destructive' : 'text-muted-foreground'}>{statusMessage}</span>
          ) : null}
          {secureRender?.status === 'FAILED' && secureRender.canRetry ? (
            <Button size="sm" variant="outline" disabled={isRetrying} onClick={handleRetry}>
              Retry
            </Button>
          ) : null}
        </div>
        {stillWorking && showIndeterminateProgress ? (
          <div className="mt-1 text-xs text-muted-foreground">Still working… this is taking longer than usual.</div>
        ) : null}
        {secureRenderTerminalError ? (
          <div className="mt-1 text-xs text-destructive flex items-center gap-2">
            <AlertCircle className="h-3.5 w-3.5" />
            <span>{secureRenderTerminalError}</span>
          </div>
        ) : null}
        {debugEnabled && secureRender?.status === 'FAILED' && secureRender.errorCode ? (
          <div className="mt-1 text-xs text-muted-foreground">errorCode: {secureRender.errorCode}</div>
        ) : null}
        {error ? (
          <div className="mt-1 text-xs text-destructive flex items-center gap-2">
            <AlertCircle className="h-3.5 w-3.5" />
            <span>{error}</span>
          </div>
        ) : null}
        {debugEnabled ? (
          <div className="mt-2 rounded-md border border-border bg-background/60 px-3 py-2">
            <div className="text-xs font-medium text-muted-foreground">Debug timeline</div>
            <div className="mt-1 space-y-1">
              {debugTimeline.length ? (
                debugTimeline.map((entry, idx) => (
                  <div key={`${entry.at}-${idx}`} className="text-xs text-muted-foreground">
                    {entry.at} → {entry.status}
                  </div>
                ))
              ) : (
                <div className="text-xs text-muted-foreground">(no status yet)</div>
              )}
            </div>
          </div>
        ) : null}
      </div>

      {/* Main content: editor only for admin, pure viewer for regular users */}
      <div className="flex-1 min-h-0 flex flex-row">
        {user?.role === 'admin' ? (
          <TicketEditor pdfUrl={pdfUrl} fileType={documentType} ticketCropMm={ticketCropMm} />
        ) : (
          <div className="h-full w-full bg-[#0b1220]">
            <div className="w-full h-full">
              {pdfUrl ? (
                <DocumentPreview docType="pdf" pdfUrl={pdfUrl} onRegionDetected={() => {}} onDisplayedSizeChange={() => {}} />
              ) : (
                <div className="h-full w-full flex items-center justify-center text-sm text-white/70">Click Preview to load</div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Custom Print Dialog */}
      <SecurePrintDialog
        open={showPrintDialog}
        onOpenChange={setShowPrintDialog}
        onConfirmPrint={handleConfirmPrint}
        remainingPrints={remainingPrints}
        maxPrints={maxPrints}
        documentTitle={documentTitle}
        isPrinting={isPrinting}
      />
    </div>
  );
};

export default Viewer;