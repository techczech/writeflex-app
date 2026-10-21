// The sharing service's build number. ONE definition for the service and the app: the service
// reports it on `GET /version`, the bundle manifest records it, and the app compares the two to
// offer Update when the installed service is older than the app's.
//
// A whole number, raised by one whenever anything under sharing-service/ changes in a way the app
// must install. A number, not a name, so the app can tell older from newer: a service put there by
// a newer WriteFlex on another Mac is never "updated" back down.
//
// No imports: the service's tsconfig and the app's both read this file as is.
export const SHARING_SERVICE_BUILD = 10

/** What `GET /version` names the program as, so the app can tell it from any other Worker. */
export const SHARING_SERVICE_NAME = 'writeflex-sharing'
