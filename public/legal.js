// Termos de Uso e Política de Privacidade (modelo). Os dados da empresa vêm de PLATFORM, em config.js.
// São textos-base: revise com um advogado antes de vender.
export const LEGAL_VERSION = '2026-11-14';

const v = (x, hint) => x ? x : `<mark>[${hint}]</mark>`;

export function termsHtml(P) {
  const who = `${v(P.company, 'razão social')}, CNPJ ${v(P.cnpj, 'CNPJ')}`;
  return `<h2>Termos de Uso</h2><p class="mut">Versão de ${LEGAL_VERSION.split('-').reverse().join('/')}</p>
  <h3>1. Quem somos</h3><p>O ${P.name} é uma plataforma de pedidos online e delivery oferecida por ${who} ("nós"). Contato: ${v(P.email, 'e-mail de contato')}.</p>
  <h3>2. O que o serviço faz</h3><p>Lojas ("lojistas") usam o ${P.name} para criar uma loja online, receber pedidos, organizar o preparo e as entregas. Os produtos são vendidos pelo lojista: a compra é uma relação entre o cliente final e a loja. Nós não vendemos, preparamos nem entregamos produtos.</p>
  <h3>3. Conta</h3><p>Para usar o painel é preciso criar uma conta com e-mail e senha. Você é responsável por manter a senha em segredo e por tudo o que for feito com a sua conta e pela sua equipe.</p>
  <h3>4. Teste grátis, planos e pagamento</h3><p>Lojas novas têm 14 dias de teste grátis. Depois, o uso depende de assinatura mensal em um dos planos exibidos no painel, paga com cartão pelo Mercado Pago. A cobrança é renovada todo mês até o cancelamento, que pode ser feito a qualquer momento no painel e interrompe as cobranças seguintes. Sem pagamento em dia, após 3 dias de carência a loja deixa de receber pedidos até a regularização. Podemos alterar preços com aviso prévio de 30 dias.</p>
  <h3>5. Responsabilidades do lojista</h3><p>O lojista é responsável por: produtos, preços, estoque, qualidade e entrega; atendimento e trocas; emissão de nota fiscal e obrigações fiscais; respeitar o Código de Defesa do Consumidor; ter direito de uso das fotos e textos que publicar; e tratar os dados dos seus clientes conforme a LGPD, como controlador desses dados.</p>
  <h3>6. Pagamentos dos pedidos</h3><p>Quando o lojista ativa o Pix online, o valor é pago diretamente na conta do Mercado Pago do lojista. Nós não recebemos nem guardamos o dinheiro dos pedidos. Pagamentos na entrega são combinados entre cliente e loja.</p>
  <h3>7. Uso proibido</h3><p>É proibido usar a plataforma para vender produtos ilegais ou sem autorização exigida por lei, enganar consumidores, enviar spam, tentar acessar dados de outras lojas ou prejudicar o funcionamento do serviço.</p>
  <h3>8. Disponibilidade e responsabilidade</h3><p>Trabalhamos para manter o serviço no ar, mas podem ocorrer interrupções por manutenção ou falhas de terceiros (hospedagem, internet, meios de pagamento). Na extensão permitida pela lei, não respondemos por lucros cessantes ou por danos decorrentes da relação entre lojista e cliente final.</p>
  <h3>9. Suspensão e encerramento</h3><p>Podemos suspender lojas que violem estes termos ou estejam com a assinatura em atraso. O lojista pode excluir a loja a qualquer momento em Configurações; isso apaga os dados da loja de forma definitiva.</p>
  <h3>10. Alterações</h3><p>Podemos atualizar estes termos. Mudanças relevantes serão avisadas no painel ou por e-mail.</p>
  <h3>11. Foro</h3><p>Fica eleito o foro da comarca de ${v(P.city, 'cidade/UF')}, ressalvados os direitos do consumidor de demandar em seu domicílio.</p>`;
}

export function privacyHtml(P) {
  return `<h2>Política de Privacidade</h2><p class="mut">Versão de ${LEGAL_VERSION.split('-').reverse().join('/')} · em conformidade com a Lei 13.709/2018 (LGPD)</p>
  <h3>1. Quem trata os seus dados</h3><p><b>Se você comprou em uma loja:</b> a loja é a controladora dos seus dados de pedido e o ${P.name} é operador, tratando os dados em nome dela. <b>Se você tem uma conta de lojista:</b> ${v(P.company, 'razão social')}, CNPJ ${v(P.cnpj, 'CNPJ')}, é a controladora dos dados da sua conta.</p>
  <h3>2. Quais dados coletamos</h3><ul>
    <li><b>Clientes das lojas:</b> nome, telefone, endereço de entrega, itens do pedido e forma de pagamento. No Pix online, o e-mail é enviado ao Mercado Pago para o comprovante e não fica guardado no ${P.name}.</li>
    <li><b>Lojistas e equipe:</b> e-mail, senha (guardada de forma criptografada), dados da loja e histórico de uso.</li>
    <li><b>Dados técnicos:</b> o navegador guarda o carrinho, os dados do último pedido para preencher o próximo e a sessão de login. Não usamos cookies de publicidade.</li></ul>
  <h3>3. Para que usamos</h3><ul>
    <li>Registrar, preparar, entregar e acompanhar pedidos (execução de contrato).</li>
    <li>Enviar mensagens sobre o pedido, quando a loja usa o WhatsApp (execução de contrato).</li>
    <li>Cobrar a assinatura e emitir documentos fiscais (execução de contrato e obrigação legal).</li>
    <li>Segurança, prevenção a fraudes e melhoria do serviço (legítimo interesse).</li></ul>
  <h3>4. Com quem compartilhamos</h3><p>Somente com fornecedores necessários para o serviço funcionar: Supabase (banco de dados e login), Vercel (hospedagem do site), Mercado Pago (pagamentos), BrasilAPI, ViaCEP e OpenStreetMap (consulta de endereço e localização no mapa) e WhatsApp, quando a loja envia uma mensagem. Alguns desses fornecedores podem armazenar dados fora do Brasil, com garantias de proteção adequadas. Não vendemos dados.</p>
  <h3>5. Por quanto tempo guardamos</h3><p>Dados de pedidos são anonimizados (nome, telefone e endereço apagados) depois de 24 meses. Dados da conta do lojista ficam guardados enquanto a conta existir e são apagados quando a loja é excluída, exceto o que a lei obrigar a manter.</p>
  <h3>6. Seus direitos</h3><p>Você pode pedir confirmação, acesso, correção, anonimização, portabilidade ou exclusão dos seus dados, e informações sobre compartilhamento (art. 18 da LGPD). Se você comprou em uma loja, fale primeiro com a loja: ela consegue excluir seus dados pelo painel. Também pode escrever para ${v(P.email, 'e-mail do encarregado')}.</p>
  <h3>7. Segurança</h3><p>Usamos conexão criptografada (HTTPS), senhas criptografadas e regras de acesso no banco de dados que impedem uma loja de ver os dados de outra.</p>
  <h3>8. Encarregado de dados (DPO)</h3><p>Contato do encarregado: ${v(P.email, 'e-mail do encarregado')}.</p>
  <h3>9. Alterações</h3><p>Esta política pode ser atualizada; a data da versão fica no topo da página.</p>`;
}
