# Feature: Include PDF Screenshot in Chat Context

Here is a high-level implementation plan to add a feature for including PDF screenshots in the chat context.

### 1. Add a Screenshot Capture Trigger

-   **Location:** `src/chat-view.ts`
-   **Action:** Add a new button to the chat input area, for example, an "Attach Screenshot" icon button next to the "Send" button.
-   **Purpose:** This button will initiate the screenshot process.

### 2. Implement the Screenshot Logic

-   **Action:** When the "Attach Screenshot" button is clicked, the plugin needs to identify the currently active PDF view.
-   **How:** Access the active PDF view through the workspace leaves: `this.app.workspace.getLeavesOfType('pdf')`.
-   **Details:**
    -   The PDF pages are rendered onto `<canvas>` elements by `pdf.js`. Your code will need to access the DOM of the active PDF view to find the visible canvas element.
    -   Capture the content of the canvas. You can get the image data as a Base64-encoded string using the `canvas.toDataURL('image/png')` method.
    -   *(Advanced)*: For a better user experience, you could implement a selection tool (e.g., drawing a rectangle) to allow the user to capture a specific region of the canvas instead of the whole visible area.

### 3. Update the Chat View UI

-   **Action:** Once the screenshot is captured, provide visual feedback to the user.
-   **How:**
    -   Display a thumbnail preview of the captured image near the chat input bar in the `ChatView`.
    -   Add a "remove" or "clear" button (e.g., an 'X' icon on the thumbnail) to allow the user to discard the attached screenshot before sending.
    -   Store the Base64 data of the screenshot in a state variable (e.g., `private attachedScreenshot: string | null = null;`) within the `ChatView` class.

### 4. Modify the API Request to Gemini

-   **Context:** The Gemini 1.5 Pro model supports multimodal input (text and images). The payload sent to the API must be adjusted.
-   **Location:** The `sendButton` click handler in `src/chat-view.ts`.
-   **Action:**
    -   Before sending the request, check if a screenshot is attached (i.e., if the `attachedScreenshot` state variable is not null).
    -   If a screenshot exists, modify the `contents` array in the request body. The `parts` array for the user's message should be updated to contain two objects: one for the text prompt and one for the image.
-   **Payload Structure:**

    ```json
    {
      "contents": [
        // ... previous conversation history ...
        {
          "role": "user",
          "parts": [
            {
              "text": "Here is the user's question about the screenshot."
            },
            {
              "inline_data": {
                "mime_type": "image/png",
                "data": "..."
              }
            }
          ]
        }
      ]
    }
    ```
    **Note:** The `"data"` value must be the pure Base64-encoded image string, without the `data:image/png;base64,` prefix. You will need to strip this prefix before sending the API request.

### 5. Update the Chat History Display

-   **Action:** When a user sends a message that includes a screenshot, the chat history UI should be updated to display both the text of the question and the screenshot image they included.
-   **How:**
    -   In the `sendButton` click handler, after creating the user message element, check if a screenshot was attached.
    -   If so, create an `<img>` element, set its `src` to the Base64 data URL of the screenshot, and append it to the user's message container.
    -   Reset the `attachedScreenshot` state variable to `null` after the message is sent.

This ensures the visual context is preserved for the user within the conversation history.
