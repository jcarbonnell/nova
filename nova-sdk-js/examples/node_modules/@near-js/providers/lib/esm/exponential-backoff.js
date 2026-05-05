async function exponentialBackoff(startWaitTime, retryNumber, waitBackoff, getResult) {
  let waitTime = startWaitTime;
  for (let i = 0; i < retryNumber; i++) {
    const result = await getResult();
    if (result) {
      return result;
    }
    await sleep(waitTime);
    waitTime *= waitBackoff;
  }
  return null;
}
function sleep(millis) {
  return new Promise((resolve) => setTimeout(resolve, millis));
}
export {
  exponentialBackoff
};
