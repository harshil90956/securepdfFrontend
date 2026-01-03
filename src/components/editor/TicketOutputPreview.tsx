import React, { useEffect, useState } from 'react';

import { X, Printer, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { api } from '@/config/api';

import type { TicketOutputPage } from './TicketEditor';

interface TicketOutputPreviewProps {
  pages: TicketOutputPage[];
  onClose: () => void;
  documentId?: string;
  fileType?: 'pdf' | 'svg';
  pdfUrl?: string;
  pdf_s3_key?: string;
  customFonts?: { family: string; dataUrl: string }[];
  slotSpacingPt?: number;
  ticketCropMm?: {
    xMm: number | null;
    yMm: number | null;
    widthMm: number | null;
    heightMm: number | null;
    cutMarginMm: number | null;
    rotationDeg: number | null;
    keepProportions: boolean | null;
    alignment: 'left' | 'center' | 'right' | null;
  } | null;
}

export const TicketOutputPreview: React.FC<TicketOutputPreviewProps> = ({ pages, onClose, documentId, fileType, pdfUrl, pdf_s3_key }) => {
  const [currentPage, setCurrentPage] = useState(0);
  const { token } = useAuth();

  const [sourcePdfUrl, setSourcePdfUrl] = useState<string | null>(pdfUrl || null);
  const resolvedPdfUrl = sourcePdfUrl;

  useEffect(() => {
    if (pdfUrl) {
      setSourcePdfUrl(pdfUrl);
      return;
    }

    if (!token) return;
    if (!pdf_s3_key) return;

    let cancelled = false;
    let blobUrl: string | null = null;

    (async () => {
      try {
        const dlRes = await api.get(`/api/download/${encodeURIComponent(pdf_s3_key)}`, {
          headers: { Authorization: `Bearer ${token}` },
          responseType: 'blob',
        });

        blobUrl = URL.createObjectURL(dlRes.data as Blob);
        if (cancelled) return;
        setSourcePdfUrl(blobUrl);
      } catch (e) {
        if (cancelled) return;
        console.error('Preview download error:', e);
        toast.error(e instanceof Error ? e.message : 'Preview download failed');
      }
    })();

    return () => {
      cancelled = true;
      if (blobUrl) {
        try {
          URL.revokeObjectURL(blobUrl);
        } catch {
          // ignore
        }
      }
    };
  }, [pdfUrl, pdf_s3_key, token]);

  const handlePrint = async () => {
    if (!resolvedPdfUrl) {
      toast.error('Preview not ready');
      return;
    }
    const win = window.open(resolvedPdfUrl, '_blank', 'noopener,noreferrer');
    if (!win) {
      toast.error('Popup blocked. Please allow popups and try again.');
      return;
    }
    toast.message('Opened PDF. Use Ctrl+P to print.');
  };

  return (
    <div className="fixed inset-0 z-50 bg-background/95 backdrop-blur-sm flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-card">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" onClick={onClose} className="gap-2">
            <X className="h-4 w-4" />
            Close
          </Button>
          <div className="h-4 w-px bg-border" />
          <span className="text-sm text-muted-foreground">Output: {pages.length} pages</span>
        </div>
        <Button onClick={handlePrint} size="sm" className="gap-2" disabled={!resolvedPdfUrl}>
          <Printer className="h-4 w-4" />
          Print
        </Button>
      </div>

      {/* Preview Content */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Page Navigation */}
        <div className="w-48 border-r border-border p-3 overflow-y-auto bg-card/50">
          <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">Pages</p>
          <div className="space-y-1">
            {pages.map((page, idx) => {
              const primarySlot = page.seriesSlots[0];
              const firstTicket = page.tickets[0];
              const lastTicket = page.tickets[3];
              const firstSeries = primarySlot && firstTicket
                ? firstTicket.seriesBySlot[primarySlot.id]?.seriesValue
                : '';
              const lastSeries = primarySlot && lastTicket
                ? lastTicket.seriesBySlot[primarySlot.id]?.seriesValue
                : '';

              return (
                <button
                  key={page.pageNumber}
                  onClick={() => setCurrentPage(idx)}
                  className={`w-full text-left px-3 py-2 rounded text-sm transition-colors ${
                    currentPage === idx
                      ? 'bg-primary text-primary-foreground'
                      : 'hover:bg-muted text-foreground'
                  }`}
                >
                  Page {page.pageNumber}
                  {firstSeries && lastSeries ? ` (${firstSeries} - ${lastSeries})` : ''}
                </button>
              );
            })}
          </div>
        </div>

        {/* Page Preview with Scroll */}
        <div className="flex-1 min-h-0">
          <div className="h-full overflow-auto p-6 bg-muted/30 flex justify-center">
            <div className="flex justify-center items-start w-full">
              {resolvedPdfUrl ? (
                <iframe
                  src={`${resolvedPdfUrl}#page=${currentPage + 1}`}
                  title="Output Preview"
                  style={{
                    width: '210mm',
                    height: '297mm',
                    background: 'white',
                  }}
                />
              ) : (
                <div
                  style={{
                    width: '210mm',
                    height: '297mm',
                    background: 'white',
                  }}
                  className="flex items-center justify-center text-sm text-muted-foreground"
                >
                  Generating preview...
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Footer Navigation */}
      <div className="flex items-center justify-center gap-4 px-4 py-3 border-t border-border bg-card">
        <Button
          variant="outline"
          onClick={() => setCurrentPage(Math.max(0, currentPage - 1))}
          disabled={currentPage === 0}
          className="gap-1"
        >
          <ChevronLeft className="h-4 w-4" />
          Previous
        </Button>
        <span className="text-sm text-muted-foreground">
          Page {currentPage + 1} of {pages.length}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setCurrentPage(Math.min(pages.length - 1, currentPage + 1))}
          disabled={currentPage === pages.length - 1}
          className="gap-1"
        >
          Next
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
};
