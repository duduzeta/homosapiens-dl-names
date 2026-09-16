# Homosapiens Download Names

Extensão (Chrome / Brave, Manifest V3) que renomeia downloads automaticamente com nomes descritivos,
usando o contexto da página de onde o arquivo veio e o LLM que você preferir (z.ai/GLM, OpenAI, Anthropic,
Gemini, OpenRouter, Groq, DeepSeek, Mistral, Ollama, LM Studio ou qualquer API compatível com OpenAI).

Ex.: `invoice_2024_03_final.pdf` → `Fatura Acme Cloud - Março 2024.pdf`

## Instalar (modo desenvolvedor)

1. Abra `brave://extensions` (ou `chrome://extensions`).
2. Ative **Modo do desenvolvedor** (canto superior direito).
3. **Carregar sem compactação** → selecione esta pasta.
4. Clique no ícone da extensão (ou "Detalhes → Opções"), escolha o provedor e cole sua API key.
5. Clique em **Testar conexão** e depois em **Salvar**.

## Como funciona

- `chrome.downloads.onDeterminingFilename` intercepta cada download antes de ele ser salvo.
- Um content script (`content.js`) registra o último elemento clicado na página (texto do botão/link,
  heading mais próximo, linha/card em volta). Esse é o sinal mais forte para o nome.
- Além disso a extensão coleta: nome original, URL do arquivo, referrer, título/URL da aba, `<h1>`,
  meta description, texto selecionado e o começo do conteúdo principal da página.
- Manda tudo para o provedor escolhido: `POST {baseUrl}/chat/completions` (formato OpenAI, usado por quase
  todos) ou `POST {baseUrl}/messages` (Anthropic). O modo *thinking* fica desligado por padrão para responder rápido.
- O nome retornado é sanitizado (caracteres inválidos, tamanho, nomes reservados do Windows) e a
  extensão original é sempre preservada. Se houver conflito, o Chrome adiciona `(1)`, `(2)`…
- Se a API falhar ou estourar o timeout, o nome original é mantido.

## Configurações

| Campo | Padrão |
|---|---|
| Provedor | z.ai (GLM). Trocar o provedor preenche Base URL e modelo com o preset dele |
| Base URL | `https://api.z.ai/api/paas/v4` (Coding Plan: `https://api.z.ai/api/coding/paas/v4`) |
| Modelo | `glm-4.7` |
| Timeout | 12 000 ms (o Chrome só espera ~15 s pela decisão do nome) |
| Thinking | Desligado. Ligar melhora os nomes, custa +3–8 s por download. Mapeado por provedor: z.ai `thinking`, OpenAI/Gemini `reasoning_effort`, OpenRouter `reasoning`, Anthropic `thinking: adaptive`; provedores sem esse controle não mostram a opção |
| Estilo | Instruções livres para o modelo (idioma, formato, o que incluir) |

### Provedores

| Provedor | Base URL | Modelo sugerido | Chave |
|---|---|---|---|
| z.ai (GLM) | `https://api.z.ai/api/paas/v4` | `glm-4.7` | sim |
| OpenAI | `https://api.openai.com/v1` | `gpt-4.1-mini` | sim |
| Anthropic | `https://api.anthropic.com/v1` | `claude-opus-5` | sim |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash` | sim |
| OpenRouter | `https://openrouter.ai/api/v1` | `google/gemini-2.5-flash` | sim |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | sim |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` | sim |
| Mistral | `https://api.mistral.ai/v1` | `mistral-small-latest` | sim |
| Ollama (local) | `http://localhost:11434/v1` | `llama3.2` | não |
| LM Studio (local) | `http://localhost:1234/v1` | o modelo carregado | não |
| Outro | qualquer API compatível com OpenAI | — | opcional |

Para adicionar um provedor novo basta incluir uma entrada em `PROVIDERS` no `background.js`.
Lembre do limite de ~15 s do Chrome: modelos lentos (ou thinking ligado) podem estourar o timeout e o nome
original é mantido.

A página de opções também mostra os últimos 30 downloads com o nome original, o novo nome e erros.

## Depurando nomes ruins

Na página de opções, cada download tem um link **contexto** que mostra exatamente o que foi enviado ao modelo
e a resposta crua. Se o contexto estiver pobre (sem clique, sem heading), o problema é a coleta — recarregue a
página de origem (o content script só entra em páginas carregadas depois da instalação/atualização da extensão).
Se o contexto estiver bom e o nome ruim, ajuste o campo **Estilo** ou ligue o **thinking**.
