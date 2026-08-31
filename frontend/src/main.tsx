/**
 * Application entry point.
 *
 * Wires the providers in the order later ones depend on: theme has no
 * dependency, auth needs nothing from the router, and offline-queue auto-flush
 * (FSD 6.8) starts unconditionally so a judge's queued marks send the moment
 * connectivity returns, even before any judge screen has mounted.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { AuthProvider } from './lib/auth';
import { ThemeProvider } from './lib/theme';
import { startAutoFlush } from './lib/offlineQueue';
import './styles/base.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 15_000,
      refetchOnWindowFocus: false,
    },
  },
});

// JDG-08-05: "On reconnection the queue is transmitted automatically in order."
startAutoFlush();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <AuthProvider>
            <App />
          </AuthProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </BrowserRouter>
  </StrictMode>,
);
