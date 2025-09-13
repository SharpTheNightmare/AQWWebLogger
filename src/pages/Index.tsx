import React, { useEffect } from 'react';
import { BotLogger } from '@/components/BotLogger';
import { ErrorBoundary } from '@/components/ErrorBoundary';

export default function Index() {
  useEffect(() => {
    // Global error handler to catch any uncaught errors
    const handleError = (event: ErrorEvent) => {
      console.error('Global error caught:', event.error);
      console.error('Error details:', {
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        error: event.error
      });
    };

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      console.error('Unhandled promise rejection:', event.reason);
    };

    // Add global error listeners
    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleUnhandledRejection);

    return () => {
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
    };
  }, []);

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-background">
        <ErrorBoundary
          fallback={
            <div className="min-h-screen flex items-center justify-center p-6">
              <div className="text-center space-y-4">
                <h2 className="text-2xl font-bold text-destructive">BotLogger Component Error</h2>
                <p className="text-muted-foreground">
                  The BotLogger component crashed. Check the browser console for details.
                </p>
                <button 
                  onClick={() => window.location.reload()} 
                  className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
                >
                  Reload Page
                </button>
              </div>
            </div>
          }
        >
          <BotLogger />
        </ErrorBoundary>
      </div>
    </ErrorBoundary>
  );
}
