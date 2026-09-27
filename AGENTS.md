# Ambiente de desenvolvimento nas VMs de agentes

- Aplicações web devem ouvir internamente em `0.0.0.0:3000`. Não usar `localhost`, `127.0.0.1`, a porta 5173 ou a porta externa do host como bind do app.
- O port-forward host → VM é responsabilidade do script que cria a VM.
- Após um `recreate` da VM, os processos antigos deixam de existir; inicie o dev server novamente.
- Antes de informar que o app está disponível, confirme LISTEN em `0.0.0.0:3000` e uma requisição HTTP local bem-sucedida.
- Quando for solicitado deixar o app disponível para teste, mantenha o processo rodando.
- Não crie túnel Cloudflare nem outro workaround sem solicitação explícita.
