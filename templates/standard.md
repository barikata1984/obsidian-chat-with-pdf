---
Year: {{date | format("YYYY")}} 
PDF: "[[storage/{{citekey}}/main.pdf|📃]]"
Tags: #note {%- for t in tags %}
  - "#{{ t.tag | lower | replace(' ', '-') }}" 
{%- endfor %} 
Import-date: "{{importDate | format("YYYY-MM-DD")}}"
Read-date:
Executive-summary: これまでの議論を踏まえ、論文を200字程度に要約せよ。制約された文字数でより有益な要約とするため、提案手法の名前などを論文タイトルから瞬時に読み取れるならば、そのような情報は含めなくて良い。また、日本語での回答であるので、もし主語がなくても文章の意味が損なわれないと判断するならば、主語は含めないこと。内容の優先順位は以下の通り：取り組んだ課題や問い（10-20%）、提案手法の根幹要素とその活用のされ方（60-80%）、確認された長所と短所（10-20%）、その他。
Citekey: {{citekey}}
Category: note
Template-verison: v1.0
---
## Summary
論文を熟読・内容を熟考の上、簡潔かつ的確に以下の質問に答えよ。重複した内容が複数の項目に記載されることなきよう注意すること。
### この論文が答えた問い、あるいは解決した課題は何か？

### 提案手法はその問い・課題にどのようにアプローチしたのか？

### そのアプローチの根幹をなす要素は何か？

### それらの要素を組み合わせて、どのようなフレームワーク（たとえばニューラルネットワーク）を全体として構築するのか？

### そのフレームワークはどのように訓練・最適化されるのか？訓練・最適化に使用される評価関数・損失関数はどのように設計されるのか？

### そのアプローチ・要素が特に参考とした既存研究と、それらと比した提案手法の新規性は何か？

### どのように提案手法を検証したか？検証の指標はどのようなもので、どのような結果が得られたか？

### 検証結果に基づいた議論、明らかになった課題はあるか？

---
## 追加議論


---
>[!Metadata]

{%- if itemType %}
> **Title**:: "{{title}}"
{%- endif %}

{%- for type, creators in creators | groupby("creatorType") %}
{%- for creator in creators %}
> **{{"First" if loop.first}}{{type | capitalize}}**:: {%- if creator.name %} {{creator.name}} {%- else %} {{creator.lastName}}, {{creator.firstName}} {%- endif %}
{%- endfor %}
{%- endfor %}

{%- if itemType %}
> **ItemType**:: {{itemType}}
{%- endif %}

{%- if itemType == "journalArticle" %}
> **Journal**:: *{{publicationTitle}}*
{%- endif %}

{%- if itemType == "bookSection" %}
> **Book**:: *{{publicationTitle}}*
{%- endif %}

{%- if publisher %}
> **Publisher**:: {{publisher}}
{%- endif %}

{%- if volume %}
> **Volume**:: {{volume}}
{%- endif %}

{%- if issue %}
> **Issue**:: {{issue}}
{%- endif %}

{%- if pages %}
> **Pages**:: {{pages}}
{%- endif %}

{%- if place %}
> **Location**:: {{place}}
{%- endif %}

{%- if DOI %}
> **DOI**:: {{DOI}}
{%- endif %}

{%- if ISBN %}
> **ISBN**:: {{ISBN}}
{%- endif %}

### BibTex
<details>
<summary> Click to show/noshow the BibTex data </summary>
```bibtex
{{bibtex}}
