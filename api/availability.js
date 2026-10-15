const S = require('../lib/admin-security');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=60');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({error:'METHOD_NOT_ALLOWED'});
  }
  try {
    const availability = await S.publicAvailability();
    return res.status(200).json({
      bookings: availability.bookings.map(item => ({start:item.start, end:item.end})),
      inquiries: availability.inquiries.map(item => ({start:item.start, end:item.end}))
    });
  } catch (error) {
    return res.status(error.status || 500).json({error:error.status ? error.message : 'BACKEND_UNAVAILABLE'});
  }
};
