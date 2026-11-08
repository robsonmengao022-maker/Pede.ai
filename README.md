# Pedeaí — plataforma de delivery (fase 1)

Site de pedidos para várias lojas. Cada loja tem seu endereço (`seusite.com.br/nome-da-loja`), cardápio, painel com pedidos em tempo real e impressão do pedido. O dinheiro vai direto para a conta de cada lojista: a plataforma não recebe nem segura nenhum valor.

## O que já funciona

- Cadastro de lojas e login (senha protegida com scrypt)
- Cardápio com categorias, fotos (por link), pausar/ativar produto
- Site do cliente: carrinho, entrega ou retirada, observações por item, acompanhamento do status
- Cada loja liga e desliga: **Pix**, **dinheiro**, **cartão na maquininha** e **link de pagamento** (cartão online)
- Pix "copia e cola" com o valor exato do pedido, gerado com a chave Pix da própria loja
- Painel em tempo real com som de aviso e **impressão automática** (térmica 80mm)
- Mensalidade por faixa de vendas do mês: até R$ 7.000 grátis · R$ 7.000–10.000 = R$ 69,90 · acima de R$ 10.000 = R$ 129,90 (pedidos cancelados não contam)
- Painel `/admin` para você ver todas as lojas, vendas e quanto cada uma deve

## Limitações atuais (seja honesto com seus lojistas)

1. **Pix não confirma sozinho.** O lojista confere no app do banco se o Pix caiu. Confirmação automática exige conta em um gateway (fase 2).
2. **Cartão online usa o link de pagamento da própria loja** (Mercado Pago, InfinitePay etc.). Esse link não leva o valor do pedido automaticamente. Na fase 2, integramos a API do Mercado Pago para gerar a cobrança com valor certo, com antifraude e autenticação do banco (3D Secure).
3. **A mensalidade é cobrada manualmente por enquanto**: o `/admin` mostra quanto cada loja deve no mês e você cobra por Pix.
4. Sem recuperação de senha por e-mail ainda.

## Colocar no ar

Requisitos: Node.js 22.5 ou mais novo. Não precisa instalar nenhum pacote (`npm install` não é necessário).

### Testar no seu computador

```bash
ADMIN_PASSWORD=escolha-uma-senha-forte node server.js
```
Abra http://localhost:3000

### Na internet (recomendado: VPS barata, ~R$ 25–40/mês)

O banco de dados é um arquivo (`data/pedeai.db`), então precisa de **disco que não apaga** (por isso evite hospedagem grátis que reinicia e perde arquivos).

1. Contrate uma VPS Ubuntu (Hostinger, Contabo, DigitalOcean, Oracle Cloud etc.).
2. Instale Node 22: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt install -y nodejs`
3. Envie a pasta `pedeai` para o servidor (WinSCP, `scp` ou `git`).
4. Rode em segundo plano com o PM2:
   ```bash
   sudo npm i -g pm2
   cd pedeai
   ADMIN_PASSWORD=sua-senha-forte PORT=3000 pm2 start server.js --name pedeai
   pm2 save && pm2 startup
   ```
5. **HTTPS obrigatório** (login e pedidos trafegam por ele). O jeito mais fácil é o Caddy, que emite o certificado sozinho. Depois de apontar seu domínio (registro.br, ~R$ 40/ano) para o IP da VPS, crie `/etc/caddy/Caddyfile`:
   ```
   seudominio.com.br {
       reverse_proxy localhost:3000
   }
   ```
   e rode `sudo apt install -y caddy && sudo systemctl reload caddy`.
6. **Backup**: copie a pasta `data/` todo dia (ex.: `cron` + `cp`, ou o backup da própria VPS). É onde ficam as lojas e os pedidos.

Acesse `/admin` com a senha que você definiu em `ADMIN_PASSWORD`.

## Impressora térmica (pedido imprime sozinho)

1. Compre uma impressora térmica **80mm USB** (Elgin i9, Epson TM-T20, Bematech MP-4200 e similares). Instale o driver do fabricante e deixe-a como **impressora padrão** do computador da loja.
2. No computador da loja, feche o Chrome e abra-o com o atalho modificado, acrescentando no final do destino: `--kiosk-printing`
   (Windows: botão direito no atalho do Chrome → Propriedades → Destino → após o `chrome.exe"` coloque um espaço e `--kiosk-printing`).
3. Abra o painel (`/painel`), vá em **Pedidos** e marque **"Imprimir automaticamente cada pedido novo"** e **"Tocar som"**.
4. Deixe essa aba aberta durante o expediente. Cada pedido novo imprime sozinho, sem janela de confirmação.
5. Faça um pedido de teste pelo seu próprio site antes de abrir.

## Próximas fases

- Mercado Pago integrado (Pix com confirmação automática + cartão com antifraude e 3D Secure)
- Cobrança automática da mensalidade das lojas
- Recuperação de senha por e-mail, cupons, horário de funcionamento, bairros com taxas diferentes
- App/PWA instalável para o lojista

## Estrutura

```
server.js          servidor + API + banco (SQLite)
public/index.html  página inicial da plataforma
public/loja.html   site de pedidos do cliente
public/painel.html painel do lojista
public/admin.html  painel do dono da plataforma
```

## Recuperação de senha por código (e-mail)

O lojista esquece a senha, toca em **Esqueci minha senha** no painel, recebe um código de 6 números no e-mail e troca a senha. O código vale 15 minutos e some depois de 5 tentativas erradas.

Usa o **Brevo** (plano gratuito, 300 e-mails por dia). Configure no Render, em **Environment Variables**:
- `BREVO_API_KEY`: chave de API criada no painel do Brevo (**SMTP & API → API Keys**)
- `MAIL_FROM`: e-mail que vai aparecer como remetente. Precisa estar verificado no Brevo (**Senders**).

Sem essas duas variáveis, a recuperação fica desligada e o painel avisa.
