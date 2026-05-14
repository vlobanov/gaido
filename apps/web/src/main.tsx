import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { App } from './App';
import {
  createQueryClient,
  createTrpcClient,
  trpc,
} from './lib/trpc';
import './styles/index.css';

const queryClient = createQueryClient();
const trpcClient = createTrpcClient();

const root = document.getElementById('root');
if (!root) throw new Error('#root element not found');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <Router>
          <App />
        </Router>
      </QueryClientProvider>
    </trpc.Provider>
  </React.StrictMode>
);
