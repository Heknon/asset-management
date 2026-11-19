import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import { applyTheme, readThemePref } from './components/app-shell';
import { RuntimeGate } from './components/runtime-gate';
import { TooltipProvider } from './components/ui/overlay';
import { ApiError } from './lib/api';
import { inBrowser, retireBrowserRuntime } from './lib/run-mode';
import { createAppRouter } from './router';
import './styles.css';

// Theme before first paint: the stored choice, else the device's.
applyTheme(readThemePref());
if (!inBrowser) void retireBrowserRuntime();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
  },
});

const router = createAppRouter(queryClient);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {inBrowser ? (
          <RuntimeGate>
            <RouterProvider router={router} />
          </RuntimeGate>
        ) : (
          <RouterProvider router={router} />
        )}
        <Toaster position="bottom-right" toastOptions={{ className: '!bg-surface !text-fg !border-border !shadow-pop !text-[13px]' }} />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
