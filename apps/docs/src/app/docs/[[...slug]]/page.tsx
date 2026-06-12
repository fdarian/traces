import type { TOCItemType } from 'fumadocs-core/toc';
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from 'fumadocs-ui/page';
import type { MDXContent } from 'mdx/types';
import { notFound } from 'next/navigation';
import { getMDXComponents } from '#/components/mdx';
import { source } from '#/lib/source';

type MdxData = {
  title: string;
  description?: string;
  body: MDXContent;
  toc: TOCItemType[];
};

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (page === undefined) notFound();

  const data = page.data as unknown as MdxData;
  return {
    title: data.title,
    description: data.description,
  };
}

export default async function Page(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (page === undefined) notFound();

  const data = page.data as unknown as MdxData;
  const MDX = data.body;

  return (
    <DocsPage toc={data.toc}>
      <DocsTitle>{data.title}</DocsTitle>
      <DocsDescription>{data.description}</DocsDescription>
      <DocsBody>
        <MDX components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
}
