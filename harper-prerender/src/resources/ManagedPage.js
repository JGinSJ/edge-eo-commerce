/**
 * @module ManagedPage
 *
 * Represents metadata for pages that are discovered and managed
 * via sitemaps or direct URL submissions.
 *
 * Managed pages are stored in the `databases.prerender.PageMeta` table
 * and track attributes such as refresh intervals, scheduling state,
 * and status transitions.
 *
 * This class extends the database-backed `PageMeta` resource and
 * provides constants for standard lifecycle statuses.
 */
export default class ManagedPage extends databases.prerender.PageMeta {
	static directURLMapping = true;

	/**
	 * Enumeration of possible page lifecycle statuses.
	 *
	 * - `idle`: Page is inactive and will not be refreshed until triggered.
	 * - `scheduled`: Page is scheduled for a future refresh.
	 * - `refreshing`: Page is currently being rendered or updated.
	 */
	static STATUS_TYPE = {
		idle: 'idle',
		scheduled: 'scheduled',
		refreshing: 'refreshing',
	};
}
