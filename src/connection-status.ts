/** Provider health is independent of whether an OAuth token exists. Never expose transport dumps as UI copy. */
export function connectionProblem(error: unknown, refusal?: { transportFailureReason?: string }) {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (/\b5\d\d\b|HTTP_5XX/i.test(message + (refusal?.transportFailureReason ?? ''))) return { status: 'unavailable', message: 'The app’s service is temporarily unavailable. Try again later; your connection was kept.' };
  if (/\b429\b|rate.?limit|too many requests/i.test(message)) return { status: 'rateLimited', message: 'The app is receiving too many requests. Wait a moment, then check again.' };
  if (/\b401\b|unauthorized/i.test(message)) return { status: 'needsAuth', message: 'This app needs you to sign in again.' };
  if (/\b403\b|forbidden/i.test(message)) return { status: 'blocked', message: 'This account does not have access. Check the app’s account permissions.' };
  if (/\b404\b|not found/i.test(message)) return { status: 'unavailable', message: 'The app’s connection endpoint could not be found. Check its setup or try again later.' };
  if (/timed? ?out|timeout|did not answer|ETIMEDOUT/i.test(message)) return { status: 'unavailable', message: 'The app did not respond in time. Check again; your connection was kept.' };
  if (/fetch failed|could not reach|ECONN|ENOTFOUND|network/i.test(message)) return { status: 'unavailable', message: 'The service could not be reached. Check your internet connection and try again.' };
  return { status: 'error', message: !message || /Streamable HTTP|POSTing|\{"/i.test(message) ? 'The app could not be reached. Check its setup and try again.' : message };
}
