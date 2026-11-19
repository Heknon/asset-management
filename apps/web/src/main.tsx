import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import { TooltipProvider } from './components/ui/overlay';
import { ApiError } from './lib/api';
import { createAppRouter } from './router';
import './styles.css';

// Theme before first paint: stored choice, else the OS preference.
try {
  const stored = localStorage.getItem('theme');
  document.documentElement.dataset.theme = stored ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
} catch {
  document.documentElement.dataset.theme = 'light';
}

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
        <RouterProvider router={router} />
        <Toaster position="bottom-right" toastOptions={{ className: '!bg-surface !text-fg !border-border !shadow-pop !text-[13px]' }} />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
