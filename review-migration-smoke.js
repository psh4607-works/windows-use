// Standalone migration smoke fixture; not imported by the application.
// Run with: node review-migration-smoke.js
function countCompletedReviews(reviews) {
  return reviews.filter((review) => review.status === "completed").length;
}

const completed = countCompletedReviews([
  { status: "queued" },
  { status: "completed" },
  { status: "failed" },
  { status: "completed" },
]);
if (completed !== 2 || countCompletedReviews([]) !== 0) {
  throw new Error("Review status smoke assertion failed");
}
console.log("Review status smoke passed");
