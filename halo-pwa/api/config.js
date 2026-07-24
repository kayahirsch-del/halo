export default function handler(req, res) {
  res.status(200).json({
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    redirectUri: `https://${req.headers.host}/api/auth/google-callback`
  });
}
