// Never log arbitrary error objects: drivers and SDKs may attach SQL,
// credentials, request headers, response bodies or nested causes.
export function errorMetadata(error) {
  const metadata = {};
  if (Number.isInteger(error?.errno)) metadata.errno = error.errno;
  if (Number.isInteger(error?.statusCode)) metadata.statusCode = error.statusCode;
  return metadata;
}
