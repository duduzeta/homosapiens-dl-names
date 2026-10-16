# Homosapiens Download Names

Extensão (Chrome / Brave, Manifest V3) que renomeia downloads automaticamente com nomes descritivos,
usando o contexto da página de onde o arquivo veio e o LLM que você preferir (Groq, Gemini, OpenAI, Anthropic, z.ai/GLM,
OpenRouter, DeepSeek, Mistral, Ollama, LM Studio ou qualquer API compatível com OpenAI).

Ex.: `invoice_2024_03_final.pdf` → `Fatura Acme Cloud - Março 2024.pdf`

## Instalar (modo desenvolvedor)

1. Abra `brave://extensions` (ou `chrome://extensions`).
2. Ative **Modo do desenvolvedor** (canto superior direito).
3. **Carregar sem compactação** → selecione esta pasta.
4. Clique no ícone da extensão (ou "Detalhes → Opções"), escolha o provedor e cole sua API key.
5. Clique em **Testar conexão** e depois em **Salvar**.

## Como funciona

O nome é preparado **antes** do download existir, pra que o prompt de salvar não espere o modelo:

1. **Hover** (`content.js`, desligado por padrão): parou ~200 ms em cima de um link/botão com cara de download (atributo `download`,
   link terminando em `.pdf`/`.zip`/`.csv`…, ou texto "Baixar"/"Download"/"Exportar"), a extensão já manda o
   contexto e chama o modelo. Limitado a 6 chamadas/min pra não gastar a cota do plano grátis.
2. **Pointerdown** (~100 ms antes do clique): mesmo contexto; se ainda não havia chamada e o elemento tem cara
   de download, ela começa aqui. Elementos sem cara de download só guardam o contexto (não gastam chamada).
3. **Download** (`chrome.downloads.onDeterminingFilename`): pega a preparação pela URL (ou pelo último
   pointerdown, no caso de botões JS). Se o nome já está pronto, responde na hora; senão espera no máximo
   **"Espera máxima no download"** (padrão 3000 ms).
4. Passou do prazo, deu erro ou o provedor devolveu 429 (limite de uso): usa um **nome alternativo** montado
   na hora com o que a página mostra — linha/card do elemento, texto do botão, título mais próximo e site
   (ex.: `Fatura #8813 - Março 2024 - Acme Cloud.pdf`). Sem nada disso, mantém o nome original.

Detalhes:
- Contexto enviado: texto do elemento clicado, linha/card em volta, heading mais próximo, título/H1/URL da
  página, nome sugerido pelo link e URL do arquivo. O texto da página só vai quando o clique não diz o bastante
  (o prompt é enxuto: ~550 tokens, porque planos grátis limitam tokens por minuto).
- Formato OpenAI (`POST {baseUrl}/chat/completions`, quase todos os provedores) ou Anthropic (`POST {baseUrl}/messages`).
  O raciocínio fica no mínimo por padrão.
- O nome é sanitizado (caracteres inválidos, tamanho, nomes reservados do Windows) e a extensão original é
  sempre preservada. Se houver conflito, o navegador adiciona `(1)`, `(2)`…
- O histórico (até 500 downloads) mostra de onde veio cada nome (`pronto`, `adiantado`, `no download`,
  `alternativo (prazo)`…), quanto o download esperou e quanto o modelo levou. Dá pra exportar em JSON.

## Configurações

| Campo | Padrão |
|---|---|
| Provedor | Groq. Trocar o provedor preenche Base URL e modelo com o preset dele; cada provedor guarda a própria chave |
| Base URL | `https://api.groq.com/openai/v1` |
| Modelo | `openai/gpt-oss-120b` |
| Espera máxima no download | 3 000 ms. Passou disso, usa o nome alternativo |
| Timeout da chamada | 3 000 ms (cada chamada ao modelo, inclusive as feitas antes do clique) |
| Preparar no hover | Desligado (ligado: máx. 6 chamadas/min, gasta chamadas quando você passa o mouse e não clica) |
| Thinking | Desligado. Ligar melhora os nomes, custa +3–8 s por download. Mapeado por provedor: z.ai `thinking`, OpenAI/Gemini `reasoning_effort`, OpenRouter `reasoning`, Anthropic `thinking: adaptive`; provedores sem esse controle não mostram a opção |
| Estilo | Instruções livres para o modelo (idioma, formato, o que incluir) |

### Provedores

| Provedor | Base URL | Modelo sugerido | Chave |
|---|---|---|---|
| z.ai (GLM) | `https://api.z.ai/api/paas/v4` (Coding Plan: `.../api/coding/paas/v4`) | `glm-4.5-air` | sim |
| OpenAI | `https://api.openai.com/v1` | `gpt-4.1-mini` | sim |
| Anthropic | `https://api.anthropic.com/v1` | `claude-haiku-4-5` | sim |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash` | sim |
| OpenRouter | `https://openrouter.ai/api/v1` | `google/gemini-2.5-flash` | sim |
| Groq | `https://api.groq.com/openai/v1` | `openai/gpt-oss-120b` | sim |
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
