# Homosapiens Download Names

Extensão (Chrome / Brave, Manifest V3) que renomeia downloads automaticamente com nomes descritivos,
usando o contexto da página de onde o arquivo veio e um modelo GLM via API do z.ai.

Ex.: `invoice_2024_03_final.pdf` → `Fatura Acme Cloud - Março 2024.pdf`

## Instalar (modo desenvolvedor)

1. Abra `brave://extensions` (ou `chrome://extensions`).
2. Ative **Modo do desenvolvedor** (canto superior direito).
3. **Carregar sem compactação** → selecione esta pasta.
4. Clique no ícone da extensão (ou "Detalhes → Opções") e cole sua API key do z.ai.
5. Clique em **Testar conexão** e depois em **Salvar**.

## Como funciona

- `chrome.downloads.onDeterminingFilename` intercepta cada download antes de ele ser salvo.
- Um content script (`content.js`) registra o último elemento clicado na página (texto do botão/link,
  heading mais próximo, linha/card em volta). Esse é o sinal mais forte para o nome.
- Além disso a extensão coleta: nome original, URL do arquivo, referrer, título/URL da aba, `<h1>`,
  meta description, texto selecionado e o começo do conteúdo principal da página.
- Manda tudo para `POST {baseUrl}/chat/completions` (API compatível com OpenAI do z.ai), com o
  modo *thinking* desligado para responder rápido.
- O nome retornado é sanitizado (caracteres inválidos, tamanho, nomes reservados do Windows) e a
  extensão original é sempre preservada. Se houver conflito, o Chrome adiciona `(1)`, `(2)`…
- Se a API falhar ou estourar o timeout, o nome original é mantido.

## Configurações

| Campo | Padrão |
|---|---|
| Base URL | `https://api.z.ai/api/paas/v4` (Coding Plan: `https://api.z.ai/api/coding/paas/v4`) |
| Modelo | `glm-4.7` |
| Timeout | 12 000 ms (o Chrome só espera ~15 s pela decisão do nome) |
| Thinking | Desligado. Ligar melhora os nomes, custa +3–8 s por download |
| Estilo | Instruções livres para o modelo (idioma, formato, o que incluir) |

A página de opções também mostra os últimos 30 downloads com o nome original, o novo nome e erros.

## Depurando nomes ruins

Na página de opções, cada download tem um link **contexto** que mostra exatamente o que foi enviado ao modelo
e a resposta crua. Se o contexto estiver pobre (sem clique, sem heading), o problema é a coleta — recarregue a
página de origem (o content script só entra em páginas carregadas depois da instalação/atualização da extensão).
Se o contexto estiver bom e o nome ruim, ajuste o campo **Estilo** ou ligue o **thinking**.
