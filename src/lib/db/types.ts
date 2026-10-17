import type { Database } from './client';

/**
 * Services accept either the pooled client or an open transaction, so the same
 * function can participate in a larger atomic operation or run standalone.
 */
export type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type DbExecutor = Database | DbTransaction;
