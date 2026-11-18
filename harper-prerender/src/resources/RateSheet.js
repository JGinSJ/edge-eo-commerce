/**
 * @module RateSheet
 *
 * The rate source for serve-time injection (see ../util/rates.js). One row,
 * id "national":
 *
 *   { id, asOf: "<ISO timestamp>", products: [{ key, rate, apr, points }, …] }
 *
 * Reads are public: the origin page fetches this through the property's
 * /_harper proxy so people and bots get their numbers from one place. The rates
 * are published on the page anyway. Writes keep Harper's default: an
 * authenticated user with write permission.
 */
export default class RateSheet extends databases.prerender.RateSheet {
	allowRead() {
		return true;
	}
}
