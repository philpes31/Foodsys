// Modelos de catálogo por segmento. Preços em reais aqui; convertidos para centavos ao criar a empresa.
const G = {
  tamPizza: ['Tamanho', 1, 1, [['Pequena (4 fatias)', 0], ['Média (6 fatias)', 12], ['Grande (8 fatias)', 22]]],
  meio: ['Meio a meio', 0, 1, [['½ Calabresa', 0], ['½ Quatro Queijos', 6], ['½ Frango c/ Catupiry', 5], ['½ Portuguesa', 4]]],
  borda: ['Borda recheada', 0, 1, [['Catupiry', 9], ['Cheddar', 9], ['Chocolate', 12]]],
  ponto: ['Ponto da carne', 1, 1, [['Mal passado', 0], ['Ao ponto', 0], ['Bem passado', 0]]],
  adicBurger: ['Adicionais', 0, 5, [['Bacon', 6], ['Cheddar extra', 4], ['Ovo', 3], ['Cebola caramelizada', 4], ['Hambúrguer extra', 12]]],
  combo: ['Transformar em combo', 0, 1, [['Batata média + refri lata', 16], ['Batata grande + refri 600ml', 22]]],
  tamAcai: ['Tamanho', 1, 1, [['300 ml', 0], ['500 ml', 7], ['700 ml', 13]]],
  compl: ['Complementos', 0, 5, [['Granola', 0], ['Leite ninho', 3], ['Paçoca', 2], ['Banana', 2], ['Morango', 4], ['Nutella', 6], ['Leite condensado', 2]]],
  sabor: ['Sabor', 1, 1, [['Coca-Cola', 0], ['Guaraná', 0], ['Fanta Laranja', 0]]],
  peso: ['Quantidade', 1, 1, [['500 g', 0], ['1 kg', 0]]]
};

export const SEGMENTS = {
  pizzaria: { name: 'Pizzaria', color: '#d62828', prep: 'Cozinha', icon: 'pizza', products: [
    ['Pizzas', 'Margherita', 'Tomate, muçarela, manjericão', 42, 'pizza', ['tamPizza', 'meio', 'borda']],
    ['Pizzas', 'Calabresa', 'Calabresa, cebola roxa, orégano', 44, 'pizza', ['tamPizza', 'meio', 'borda']],
    ['Pizzas', 'Quatro Queijos', 'Muçarela, provolone, parmesão, gorgonzola', 48, 'pizza', ['tamPizza', 'meio', 'borda']],
    ['Pizzas', 'Pepperoni', 'Pepperoni artesanal e muçarela', 50, 'pizza', ['tamPizza', 'meio', 'borda']],
    ['Doces', 'Chocolate com Morango', 'Chocolate ao leite e morangos', 46, 'pizza', ['tamPizza']],
    ['Bebidas', 'Refrigerante 2L', 'Escolha o sabor', 14, 'bottle', ['sabor']],
    ['Bebidas', 'Água sem gás', '500 ml', 5, 'bottle', []]] },
  hamburgueria: { name: 'Hamburgueria', color: '#e85d04', prep: 'Chapa', icon: 'burger', products: [
    ['Burgers', 'Clássico', 'Blend 160g, queijo, alface, tomate, molho da casa', 29, 'burger', ['ponto', 'adicBurger', 'combo']],
    ['Burgers', 'Bacon Duplo', '2 blends 120g, cheddar, bacon crocante', 39, 'burger', ['ponto', 'adicBurger', 'combo']],
    ['Burgers', 'Smash Salad', 'Smash 90g, queijo prato, salada', 24, 'burger', ['adicBurger', 'combo']],
    ['Burgers', 'Veggie', 'Burger de grão-de-bico, rúcula, tomate seco', 31, 'burger', ['adicBurger', 'combo']],
    ['Porções', 'Batata rústica', '400 g com alecrim e páprica', 22, 'box', []],
    ['Bebidas', 'Refri lata', '350 ml', 7, 'bottle', ['sabor']],
    ['Bebidas', 'Milkshake', 'Ovomaltine, 400 ml', 19, 'cup', []]] },
  acai: { name: 'Açaiteria', color: '#6a2c91', prep: 'Montagem', icon: 'cup', products: [
    ['Açaí', 'Açaí tradicional', 'Açaí puro batido na hora', 16, 'cup', ['tamAcai', 'compl']],
    ['Açaí', 'Açaí com cupuaçu', 'Metade açaí, metade creme de cupuaçu', 18, 'cup', ['tamAcai', 'compl']],
    ['Açaí', 'Açaí zero açúcar', 'Adoçado com xilitol', 19, 'cup', ['tamAcai', 'compl']],
    ['Cremes', 'Creme de ninho', 'Cremoso de leite ninho', 17, 'cup', ['tamAcai', 'compl']],
    ['Bebidas', 'Água de coco', '300 ml', 8, 'bottle', []]] },
  mercado: { name: 'Mercado', color: '#2f8f46', prep: 'Separação', icon: 'box', products: [
    ['Mercearia', 'Arroz tipo 1 — 5 kg', 'Pacote', 27.9, 'box', []],
    ['Mercearia', 'Feijão carioca — 1 kg', 'Pacote', 8.49, 'box', []],
    ['Mercearia', 'Café torrado — 500 g', 'Moagem tradicional', 18.9, 'box', []],
    ['Hortifrúti', 'Banana prata', 'Preço por kg', 6.99, 'leaf', []],
    ['Hortifrúti', 'Tomate', 'Preço por kg', 8.99, 'leaf', []],
    ['Limpeza', 'Detergente 500 ml', 'Neutro', 2.79, 'bottle', []],
    ['Bebidas', 'Cerveja lata 350 ml', 'Pack com 12', 42.9, 'bottle', []]] },
  farmacia: { name: 'Farmácia', color: '#0b7285', prep: 'Separação', icon: 'pill', products: [
    ['Medicamentos', 'Dipirona 500 mg', '10 comprimidos · isento de prescrição', 6.9, 'pill', []],
    ['Medicamentos', 'Paracetamol 750 mg', '20 comprimidos · isento de prescrição', 12.5, 'pill', []],
    ['Higiene', 'Creme dental 90 g', 'Proteção anticáries', 5.49, 'box', []],
    ['Higiene', 'Protetor solar FPS 50', '200 ml', 49.9, 'bottle', []],
    ['Bem-estar', 'Vitamina C 1 g', '10 comprimidos efervescentes', 19.9, 'pill', []]] },
  outro: { name: 'Outro negócio', color: '#3d5a80', prep: 'Preparo', icon: 'box', products: [
    ['Produtos', 'Produto exemplo', 'Edite em Cardápio', 20, 'box', []]] }
};

export const PLANS = {
  'Básico': { price: 7900, monthlyOrders: 300, features: 'Loja online, painel de preparo, até 300 pedidos/mês' },
  'Pro': { price: 14900, monthlyOrders: null, features: 'Pedidos ilimitados, entregadores, cupons, relatórios' },
  'Rede': { price: 34900, monthlyOrders: null, features: 'Várias unidades, API, domínio próprio, suporte prioritário' }
};

export const cents = v => Math.round(v * 100);

export function templateProducts(segment) {
  const seg = SEGMENTS[segment];
  if (!seg) throw new Error('Segmento inválido');
  return seg.products.map(([category, name, description, price, icon, groups], i) => ({
    category, name, description, price: cents(price), icon, sort: i,
    groups: groups.map((k, gi) => {
      const [gname, min, max, opts] = G[k];
      return { name: gname, min_sel: min, max_sel: max, sort: gi, options: opts.map(([n, p], oi) => ({ name: n, price: cents(p), sort: oi })) };
    })
  }));
}
