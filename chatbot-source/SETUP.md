# Setup Guide - Fix SSL Certificate Error

## Problem
You're encountering this error: **"unable to get local issuer certificate"**

This happens when Node.js cannot verify SSL certificates when connecting to external APIs (Stream Chat, OpenAI, Gemini, etc.) in development environments.

---

## Quick Fix for Development

### Backend Setup

1. **Navigate to the backend directory:**
   ```bash
   cd chatbot-source/nodejs-ai-assistant
   ```

2. **Add this line to your `.env` file:**
   ```env
   NODE_TLS_REJECT_UNAUTHORIZED=0
   ```

   Your complete `.env` file should look like this:
   ```env
   STREAM_API_KEY=your_stream_api_key_here
   STREAM_API_SECRET=your_stream_api_secret_here

   OPENAI_API_KEY=your_openai_api_key_here

   TAVILY_API_KEY=your_tavily_api_key_here
   GEMINI_API_KEY=your_gemini_api_key_here

   # SSL Configuration for Development
   NODE_TLS_REJECT_UNAUTHORIZED=0
   ```

   **Important:** Replace the placeholder values with your actual API keys.

3. **Install dependencies (if not already done):**
   ```bash
   npm install
   ```

4. **Start the backend server:**
   ```bash
   npm run dev
   ```

   You should see:
   ```
   Server is running on http://localhost:3000
   ```

---

### Frontend Setup

1. **Navigate to the frontend directory:**
   ```bash
   cd chatbot-source/react-stream-ai-assistant
   ```

2. **Your `.env` file should look like this:**
   ```env
   VITE_STREAM_API_KEY=your_stream_api_key_here
   VITE_BACKEND_URL=http://localhost:3000
   ```

   **Important:** Use the same Stream API key as in the backend.

3. **Install dependencies (if not already done):**
   ```bash
   npm install
   ```

4. **Start the frontend development server:**
   ```bash
   npm run dev
   ```

   You should see:
   ```
   VITE v5.x.x  ready in XXX ms
   ➜  Local:   http://localhost:8080/
   ```

---

## Testing the Application

1. **Open your browser** and go to: `http://localhost:8080`

2. **Create a user account:**
   - Enter your name
   - Click "Login"

3. **Start a new chat session:**
   - Click "New Chat" or start typing

4. **Connect the AI Agent:**
   - Click the "Connect" button in the top-right corner
   - Wait for it to show "Connected" (green indicator)

5. **Test with a math question:**
   ```
   What is 25 + 37?
   ```

---

## Important Notes

### ⚠️ Security Warning
- **`NODE_TLS_REJECT_UNAUTHORIZED=0` is ONLY for development!**
- This disables SSL certificate verification, which is insecure
- **NEVER use this in production!**
- For production, you need proper SSL certificate configuration

### Alternative Solutions for Production

If you need a more secure solution:

1. **Update Node.js certificates:**
   ```bash
   npm install -g win-ca   # Windows
   # or
   npm install -g node-ca  # Linux/Mac
   ```

2. **Use a proper CA bundle:**
   - Set `NODE_EXTRA_CA_CERTS` environment variable
   - Point to a valid CA certificate bundle

3. **Check your network/proxy:**
   - Corporate networks may intercept SSL
   - Configure proxy settings if needed

---

## Troubleshooting

### Backend won't start
- Check if port 3000 is already in use
- Verify all environment variables are set correctly
- Check Node.js version (requires Node.js 20+)

### Frontend won't connect
- Make sure backend is running first
- Check that `VITE_BACKEND_URL` points to `http://localhost:3000`
- Clear browser cache and reload

### AI Agent won't connect
- Check browser console for errors
- Verify Stream API credentials are correct
- Ensure Gemini API key is valid and has quota

### "Quota exceeded" errors
- Check your Gemini API quota at: https://console.cloud.google.com/
- Or check OpenAI quota at: https://platform.openai.com/account/billing

---

## Running Commands Summary

```bash
# Terminal 1 - Backend
cd chatbot-source/nodejs-ai-assistant
npm install
npm run dev

# Terminal 2 - Frontend
cd chatbot-source/react-stream-ai-assistant
npm install
npm run dev

# Open browser: http://localhost:8080
```

---

## API Keys Used

- **Stream Chat**: For real-time messaging infrastructure
- **Gemini API**: Primary AI model for math tutoring (gemini-2.5-pro)
- **OpenAI API**: Alternative AI model (gpt-4o)
- **Tavily API**: For web search capabilities

---

## Questions?

If you continue to have issues:
1. Check the backend terminal for error messages
2. Check the browser console (F12) for frontend errors
3. Verify all API keys are valid and have quota
4. Ensure you're running Node.js 20 or higher
