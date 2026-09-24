import { api, ApiError } from './api';
import { prepareBulkImport, type BulkImportRequest, type BulkImportResult } from './bulkWordImport';
import type { Word } from './vocabulary';

/**
 * A bulk import used to be ONE Firestore transaction: read the account document,
 * compute the new lists / custom words / active selection, write it back.
 *
 * D1 has no interactive (read-then-write) transactions, so we get the same
 * guarantee with optimistic locking:
 *   1. read the row, noting its `version`
 *   2. compute the result locally
 *   3. write "only if the version is still this one"
 * If another device saved in between, the API answers 409 and we refetch and
 * retry (up to 3 attempts). Nothing is ever written half-applied: `PUT /api/me`
 * writes all three fields together.
 */
export async function commitBulkImport(
  uid: string,
  request: BulkImportRequest,
  originals: Word[],
  stillOwner: () => boolean = () => true,
): Promise<BulkImportResult> {
  const MAX_ATTEMPTS = 3;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (!stillOwner()) throw new Error('Account changed. Nothing was imported for this account.');

    const current = await api.me();
    if (!stillOwner()) throw new Error('Account changed. Sign in again and retry the import.');

    const result = prepareBulkImport(
      { lists: current.lists, customWords: current.customWords, activeId: current.activeId },
      request,
      originals,
      new Date().toISOString(),
    );

    try {
      await api.saveMe({
        lists: result.lists,
        customWords: result.customWords,
        activeId: result.list.id,
        version: current.version,
      });
      if (!stillOwner()) throw new Error('Account changed. Nothing was imported for this account.');
      return result;
    } catch (err) {
      // 409 = someone else saved first. Refetch and try again with their version.
      if (err instanceof ApiError && err.isStale && attempt < MAX_ATTEMPTS - 1) continue;
      throw err;
    }
  }

  throw new Error('Could not save the import. Please try again.');
}
