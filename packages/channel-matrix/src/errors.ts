/** A configuration (or account state) the user has to change; never retried. */
export class MatrixSetupError extends Error {
	public override readonly name = "MatrixSetupError";
}
