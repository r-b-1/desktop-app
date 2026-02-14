# TODO

## Web Search Integration (OpenAI Responses API)

### Phase 1: API Migration
- [ ] Change API endpoint from `/v1/chat/completions` to `/v1/responses`
- [ ] Update `ChatCompletionOptions` type to include `tools` array
- [ ] Add `Tool` and `WebSearchTool` type definitions

### Phase 2: Request/Response Updates
- [ ] Modify request body: change `messages` → `input`
- [ ] Update `formatMessages()` function compatibility
- [ ] Add `tools` parameter to `streamChatCompletion()` options

### Phase 3: Streaming Parser Update
- [ ] Update SSE parser for new response format (`output` instead of `choices`)
- [ ] Handle `web_search_call` events
- [ ] Handle `output_text` delta events
- [ ] Extract citation annotations from responses

### Phase 4: UI Implementation
- [ ] Add web search toggle button in chat input area
- [ ] Show "Searching..." indicator when tool is called
- [ ] Render citation links in assistant messages
- [ ] Cache toggle state per session

### Phase 5: Testing
- [ ] Test with real-time queries (NBA scores, news)
- [ ] Verify citations render correctly
- [ ] Test streaming with tool calls
- [ ] Add error handling for failed searches

## Notes
- Cost: ~$0.03 per search request
- Model: gpt-4o-mini (already configured)
- API: Responses API required (not Chat Completions)
- Documentation: https://platform.openai.com/docs/guides/tools-web-search
