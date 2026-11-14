// Dados públicos do projeto Supabase (Project Settings → API Keys).
// A Publishable key é pública por natureza; a segurança vem das regras RLS da migração.
// NUNCA coloque aqui a chave secreta (sb_secret_...) nem a senha do banco.
export const SUPABASE_URL = 'https://geuenvijxqajqekxnafm.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_oYaeWXRkl7a7NLHvMGDpZg_M3LJJjPr';

// Dados da empresa dona da plataforma — aparecem nos Termos de Uso e na Política de Privacidade.
// Preencha antes de começar a vender (e peça para um advogado revisar os textos).
export const PLATFORM = {
  name: 'Balcão',               // nome comercial da plataforma
  company: '',                  // razão social, ex.: 'Fulano Tecnologia LTDA'
  cnpj: '',                     // ex.: '00.000.000/0001-00'
  email: '',                    // e-mail de contato e do encarregado de dados (DPO)
  city: ''                      // cidade/UF do foro, ex.: 'São Paulo/SP'
};
